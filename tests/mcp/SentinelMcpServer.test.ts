import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { SentinelMcpServer } from '../../src/mcp/SentinelMcpServer.js';
import { PatchStagingManager } from '../../src/diff/PatchStagingManager.js';
import { CodebaseMri } from '../../src/context/CodebaseMri.js';
import { ContextAuction } from '../../src/context/ContextAuction.js';

describe('SentinelMcpServer (MCP Tool Execution Layer)', () => {
  let tempDir: string;
  let server: SentinelMcpServer;
  let patchManager: PatchStagingManager;
  let mri: CodebaseMri;
  let auction: ContextAuction;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sentinel_mcp_test_'));
    patchManager = new PatchStagingManager(tempDir);
    mri = new CodebaseMri(tempDir);
    auction = new ContextAuction(tempDir, mri, 8000);
    server = new SentinelMcpServer(tempDir, patchManager, mri, auction, 9199);
  });

  afterEach(async () => {
    await server.stop();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('initializes and provides correct SSE URL', () => {
    expect(server.getPort()).toBe(9199);
    expect(server.getSseUrl()).toBe('http://localhost:9199/sse');
  });

  it('starts and stops HTTP/SSE server cleanly', async () => {
    await server.start();
    const resp = await fetch('http://localhost:9199/healthz');
    expect(resp.status).toBe(200);
    const json = (await resp.json()) as { status: string };
    expect(json.status).toBe('ok');
    await server.stop();
  });
});

