import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { TrueForgeHarnessClient } from '../../src/agent/TrueForgeHarnessClient.js';
import { SentinelMcpServer } from '../../src/mcp/SentinelMcpServer.js';
import { PatchStagingManager } from '../../src/diff/PatchStagingManager.js';
import { CodebaseMri } from '../../src/context/CodebaseMri.js';
import { ContextAuction } from '../../src/context/ContextAuction.js';

describe('TrueForgeHarnessClient (Harness Connection & Inference Probe)', () => {
  it('connects to running local TrueForge instance and retrieves health', async () => {
    const client = new TrueForgeHarnessClient('http://localhost:8790', 'trueforge-standalone');
    const health = await client.checkHealth();

    expect(health.status).toBe('ok');
    expect(health.version).toBeDefined();
  });

  it('lists configured models and confirms Groq Qwen provider mapping', async () => {
    const client = new TrueForgeHarnessClient('http://localhost:8790', 'trueforge-standalone');
    const models = await client.listConfiguredModels();

    expect(models.length).toBeGreaterThan(0);
    expect(models.some((m) => m.includes('qwen') || m.includes('groq'))).toBe(true);
  });

  it('executes a real model inference turn through TrueForge with MCP streaming', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tf_infer_test_'));
    const patchManager = new PatchStagingManager(tempDir);
    const mri = new CodebaseMri(tempDir);
    const auction = new ContextAuction(tempDir, mri, 4000);
    const mcpServer = new SentinelMcpServer(tempDir, patchManager, mri, auction, 9098);
    await mcpServer.start();

    const client = new TrueForgeHarnessClient('http://localhost:8790', 'trueforge-standalone');
    await client.registerSentinelMcpServer(mcpServer.getSseUrl());

    const sessionId = await client.createSession({
      instructions: 'You are a concise test assistant. Answer in fewer than 5 words.',
    });

    let receivedTokens = false;
    let turnCompleted = false;

    await client.runTurn(sessionId, 'Reply with the word SUCCESS.', {
      onTokenDelta: (delta) => {
        if (delta && delta.trim().length > 0) {
          receivedTokens = true;
        }
      },
      onToolCall: (call) => {
        receivedTokens = true;
      },
      onTurnComplete: (res) => {
        turnCompleted = true;
      },
    });

    expect(receivedTokens).toBe(true);
    expect(turnCompleted).toBe(true);

    await mcpServer.stop();
    await fs.rm(tempDir, { recursive: true, force: true });
  }, 45000);
});
