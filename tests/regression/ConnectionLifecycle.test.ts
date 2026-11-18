import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import { SentinelMcpServer } from '../../src/mcp/SentinelMcpServer.js';
import { TrueForgeHarnessClient } from '../../src/agent/TrueForgeHarnessClient.js';
import { ConnectionLifecycleManager } from '../../src/agent/ConnectionLifecycleManager.js';
import { PatchStagingManager } from '../../src/diff/PatchStagingManager.js';
import { CodebaseMri } from '../../src/context/CodebaseMri.js';
import { ContextAuction } from '../../src/context/ContextAuction.js';

describe('Regression: Connection Lifecycle, Authoritative Port & Reconnection', () => {
  let tempDir: string;
  let patchManager: PatchStagingManager;
  let mri: CodebaseMri;
  let auction: ContextAuction;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sentinel-conn-test-'));
    patchManager = new PatchStagingManager(tempDir);
    mri = new CodebaseMri(tempDir);
    await mri.scan();
    auction = new ContextAuction(tempDir, mri, 16000);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('binds to authoritative port and rejects without silent port-hopping if port is occupied by foreign process', async () => {
    const testPort = 19099;
    // Start an alien HTTP server on testPort
    const alienServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Foreign Alien Process');
    });

    await new Promise<void>((resolve) => alienServer.listen(testPort, () => resolve()));

    const sentinelServer = new SentinelMcpServer(tempDir, patchManager, mri, auction, testPort);

    try {
      await expect(sentinelServer.start()).rejects.toThrow(/Port is already in use by another process/);
      // Verify port was NOT silently hopped to 19100 or 19101
      expect(sentinelServer.getPort()).toBe(testPort);
      expect(sentinelServer.getSseUrl()).toBe(`http://localhost:${testPort}/sse`);
    } finally {
      await sentinelServer.stop();
      await new Promise<void>((resolve) => alienServer.close(() => resolve()));
    }
  });

  it('safely re-uses authoritative port on VS Code reload when healthy Sentinel MCP server is already listening', async () => {
    const testPort = 19098;
    const initialServer = new SentinelMcpServer(tempDir, patchManager, mri, auction, testPort);
    await initialServer.start();

    // Verify initial server is listening and responding to healthz
    expect(initialServer.getSseUrl()).toBe(`http://localhost:${testPort}/sse`);

    // Simulate reload: second instance attempts to start on the same port
    const reloadedServer = new SentinelMcpServer(tempDir, patchManager, mri, auction, testPort);
    await expect(reloadedServer.start()).resolves.toBeUndefined();
    expect(reloadedServer.getPort()).toBe(testPort);
    expect(reloadedServer.getSseUrl()).toBe(`http://localhost:${testPort}/sse`);

    await reloadedServer.stop();
    await initialServer.stop();
  });

  it('detects daemon disconnection and never reports connected:true when daemon is unreachable', async () => {
    const deadClient = new TrueForgeHarnessClient('http://localhost:58790', 'test-token');
    const mockMcp = new SentinelMcpServer(tempDir, patchManager, mri, auction, 19097);

    // Mock MCP server as healthy
    vi.spyOn(deadClient, 'checkMcpServerHealth').mockResolvedValue(true);

    const lifecycle = new ConnectionLifecycleManager(deadClient, mockMcp, tempDir);
    const status = await lifecycle.checkStatus();

    expect(status.connected).toBe(false);
    expect(status.daemonOnline).toBe(false);
    expect(status.mcpOnline).toBe(true);
    expect(status.state).toBe('degraded_daemon');
    expect(status.error).toContain('TrueForge daemon unreachable');

    lifecycle.dispose();
  });

  it('detects MCP connection refusal and never reports connected:true when MCP is unreachable', async () => {
    const client = new TrueForgeHarnessClient('http://localhost:8790', 'test-token');
    const mockMcp = new SentinelMcpServer(tempDir, patchManager, mri, auction, 19096);

    // Mock daemon as healthy, but MCP server as refused
    vi.spyOn(client, 'checkHealth').mockResolvedValue({ status: 'ok', version: '0.1.0' });
    vi.spyOn(client, 'checkMcpServerHealth').mockResolvedValue(false);
    vi.spyOn(mockMcp, 'start').mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:19096'));

    const lifecycle = new ConnectionLifecycleManager(client, mockMcp, tempDir);
    const status = await lifecycle.checkStatus();

    expect(status.connected).toBe(false);
    expect(status.daemonOnline).toBe(true);
    expect(status.mcpOnline).toBe(false);
    expect(status.state).toBe('degraded_mcp');
    expect(status.error).toContain('Sentinel MCP server offline on port 19096');

    lifecycle.dispose();
  });

  it('detects stale MCP registration on TrueForge and rectifies it to the authoritative endpoint', async () => {
    const client = new TrueForgeHarnessClient('http://localhost:8790', 'test-token');
    const authoritativeUrl = 'http://localhost:9099/sse';

    // Simulate TrueForge holding stale port 9101 registration in SQLite
    let registeredUrlInDb = 'http://localhost:9101/sse';

    vi.spyOn(client, 'getRegisteredMcpServer').mockImplementation(async () => {
      return {
        name: 'forge-sentinel-mcp',
        url: registeredUrlInDb,
        type: 'remote',
      };
    });

    const registerSpy = vi.spyOn(client, 'registerSentinelMcpServer').mockImplementation(async (url: string) => {
      registeredUrlInDb = url;
      return true;
    });

    const result = await client.ensureMcpServerSynchronized(authoritativeUrl);
    expect(result.synchronized).toBe(true);
    expect(registerSpy).toHaveBeenCalledWith(authoritativeUrl);
    expect(registeredUrlInDb).toBe(authoritativeUrl);
  });

  it('automatically reconnects with bounded retries when daemon becomes available', async () => {
    vi.useFakeTimers();

    const client = new TrueForgeHarnessClient('http://localhost:8790', 'test-token');
    const mockMcp = new SentinelMcpServer(tempDir, patchManager, mri, auction, 19095);

    let daemonIsUp = false;
    vi.spyOn(client, 'checkMcpServerHealth').mockResolvedValue(true);
    vi.spyOn(client, 'checkHealth').mockImplementation(async () => {
      if (!daemonIsUp) throw new Error('ECONNREFUSED 127.0.0.1:8790');
      return { status: 'ok', version: '0.1.0' };
    });
    vi.spyOn(client, 'ensureGeminiProviderConfigured').mockResolvedValue(true);
    vi.spyOn(client, 'ensureMcpServerSynchronized').mockResolvedValue({ synchronized: true });
    vi.spyOn(client, 'resolveAuthoritativeModel').mockResolvedValue({
      name: 'google-gemini/gemini-3-8-flash',
      displayName: 'Gemini 3.8 Flash (Google)',
      isAvailable: true,
      provider: 'google',
    });
    vi.spyOn(client, 'getAvailableModels').mockResolvedValue([]);

    const statusUpdates: string[] = [];
    const lifecycle = new ConnectionLifecycleManager(client, mockMcp, tempDir, (status) => {
      statusUpdates.push(status.state);
    });

    lifecycle.startMonitoring();
    await vi.advanceTimersByTimeAsync(0);

    // Initial state: daemon is down
    expect(statusUpdates[statusUpdates.length - 1]).toBe('degraded_daemon');
    expect(lifecycle.getLastStatus()?.connected).toBe(false);

    // Advance backoff timer while still down
    await vi.advanceTimersByTimeAsync(2500);
    expect(statusUpdates[statusUpdates.length - 1]).toBe('degraded_daemon');

    // Daemon comes back online
    daemonIsUp = true;
    await vi.advanceTimersByTimeAsync(3500);

    // Reconnected!
    expect(statusUpdates[statusUpdates.length - 1]).toBe('connected');
    expect(lifecycle.getLastStatus()?.connected).toBe(true);
    expect(lifecycle.getLastStatus()?.activeModel).toBe('Gemini 3.8 Flash (Google)');

    lifecycle.dispose();
    vi.useRealTimers();
  });

  it('cleans up all transports and sockets on stop() to enable immediate restart without EADDRINUSE', async () => {
    const testPort = 19094;
    const server = new SentinelMcpServer(tempDir, patchManager, mri, auction, testPort);
    await server.start();

    // Verify it is listening
    const resp = await fetch(`http://localhost:${testPort}/healthz`);
    expect(resp.status).toBe(200);

    // Stop server
    await server.stop();

    // Port should be released immediately; a new server can bind to the same port without error
    const newServer = new SentinelMcpServer(tempDir, patchManager, mri, auction, testPort);
    await expect(newServer.start()).resolves.toBeUndefined();
    await newServer.stop();
  });
});
