import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { TrueForgeHarnessClient } from '../../src/agent/TrueForgeHarnessClient.js';
import { SentinelMcpServer } from '../../src/mcp/SentinelMcpServer.js';
import { PatchStagingManager } from '../../src/diff/PatchStagingManager.js';
import { CodebaseMri } from '../../src/context/CodebaseMri.js';
import { ContextAuction } from '../../src/context/ContextAuction.js';

describe('TrueForgeHarnessClient (Harness Connection & Inference Probe)', () => {
  let tempDir: string;
  let patchManager: PatchStagingManager;
  let mri: CodebaseMri;
  let auction: ContextAuction;
  let mcpServer: SentinelMcpServer;
  let client: TrueForgeHarnessClient;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tf_infer_test_'));
    await fs.writeFile(path.join(tempDir, 'package.json'), JSON.stringify({ name: 'sample-project', version: '1.0.0' }, null, 2));
    await fs.writeFile(path.join(tempDir, 'README.md'), '# Sample Project\nArchitecture: Clean MVC microservice.');
    await fs.mkdir(path.join(tempDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(tempDir, 'src', 'index.ts'), 'export const start = () => console.log("running");');
    await fs.writeFile(path.join(tempDir, 'src', 'server.ts'), 'export class Server { public port = 3000; }');

    patchManager = new PatchStagingManager(tempDir);
    mri = new CodebaseMri(tempDir);
    await mri.scan();
    auction = new ContextAuction(tempDir, mri, 4000);
    mcpServer = new SentinelMcpServer(tempDir, patchManager, mri, auction, 9099);
    await mcpServer.start();

    client = new TrueForgeHarnessClient('http://localhost:8790', 'trueforge-standalone');
    await client.registerSentinelMcpServer(mcpServer.getSseUrl());
  });

  afterAll(async () => {
    if (mcpServer) {
      await mcpServer.stop();
    }
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('connects to running local TrueForge instance and retrieves health', async () => {
    const health = await client.checkHealth();

    expect(health.status).toBe('ok');
    expect(health.version).toBeDefined();
  });

  it('lists configured models and confirms Google Gemini 3.8 Flash primary provider mapping', async () => {
    await client.ensureGeminiProviderConfigured();
    const models = await client.listConfiguredModels();

    expect(models.length).toBeGreaterThan(0);
    expect(models.some((m) => m.includes('gemini-3-8-flash') || m.includes('gemini'))).toBe(true);

    const authoritative = await client.resolveAuthoritativeModel();
    expect(authoritative.modelId).toBe('gemini-3.8-flash');
    expect(authoritative.displayName).toBe('Gemini 3.8 Flash (Google)');
  });

  it('executes a real model inference turn through TrueForge with MCP streaming', async () => {
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
      onToolCall: () => {
        receivedTokens = true;
      },
      onTurnComplete: () => {
        turnCompleted = true;
      },
    });

    expect(receivedTokens).toBe(true);
    expect(turnCompleted).toBe(true);
  }, 45000);

  it('executes a live read-only architecture query turn with streaming and zero file modifications', async () => {
    const authoritativeModel = await client.resolveAuthoritativeModel();
    expect(authoritativeModel.modelId).toBe('gemini-3.8-flash');
    expect(authoritativeModel.displayName).toBe('Gemini 3.8 Flash (Google)');

    let receivedTokens = 0;
    let accumulatedContent = '';
    let turnStatus = '';
    let turnError: string | undefined;

    for (let attempt = 0; attempt < 3; attempt++) {
      receivedTokens = 0;
      accumulatedContent = '';
      turnStatus = '';
      turnError = undefined;

      const sessionId = await client.createSession({
        modelName: authoritativeModel.name,
        instructions: 'You are FORGE//SENTINEL. Answer repository queries directly and concisely in under 25 words without calling tools.',
      });

      await client.runTurn(sessionId, 'Analyze this repository and explain its architecture.', {
        onTokenDelta: (delta) => {
          if (delta) {
            receivedTokens++;
            accumulatedContent += delta;
          }
        },
        onToolCall: () => {
          receivedTokens++;
        },
        onTurnComplete: (res) => {
          turnStatus = res.status;
          turnError = res.error;
        },
      });

      if (turnError && turnError.includes('429')) {
        await new Promise((resolve) => setTimeout(resolve, 10000));
        continue;
      }
      break;
    }

    expect(receivedTokens).toBeGreaterThan(0);
    expect(turnStatus).not.toBe('failed');
    expect(turnError).toBeUndefined();
    expect(accumulatedContent.length).toBeGreaterThan(0);

    // Verify 0 modifications staged
    expect(patchManager.getAllStaged().length).toBe(0);
  }, 120000);
});
