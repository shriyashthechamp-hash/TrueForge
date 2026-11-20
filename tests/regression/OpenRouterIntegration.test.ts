import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { TrueForgeHarnessClient } from '../../src/agent/TrueForgeHarnessClient.js';
import { SentinelMcpServer } from '../../src/mcp/SentinelMcpServer.js';
import { PatchStagingManager } from '../../src/diff/PatchStagingManager.js';
import { CodebaseMri } from '../../src/context/CodebaseMri.js';
import { ContextAuction } from '../../src/context/ContextAuction.js';

describe('OpenRouter Provider Integration & Multi-Turn Verification', () => {
  let tempDir: string;
  let patchManager: PatchStagingManager;
  let mri: CodebaseMri;
  let auction: ContextAuction;
  let mcpServer: SentinelMcpServer;
  let client: TrueForgeHarnessClient;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tf_openrouter_test_'));
    await fs.writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ name: 'openrouter-test-app', version: '1.0.0' }, null, 2)
    );
    await fs.writeFile(path.join(tempDir, 'README.md'), '# OpenRouter Test Project\nArchitecture: Test harness.');

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
    if (mcpServer) await mcpServer.stop();
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('discovers OpenRouter models alongside Gemini in TrueForge model registry', async () => {
    const models = await client.getAvailableModels();
    const openRouterModels = models.filter((m) => m.name.startsWith('openrouter/'));

    expect(openRouterModels.length).toBeGreaterThan(0);
    expect(openRouterModels.some((m) => m.name.includes('llama') || m.name.includes('gemini'))).toBe(true);
  });

  it('executes a real OpenRouter basic inference turn with streaming', async () => {
    const modelName = 'openrouter/llama-3-3-70b-instruct';
    const sessionId = await client.createSession({
      modelName,
      instructions: 'You are a test assistant. Answer in fewer than 5 words.',
    });

    let receivedTokens = 0;
    let turnStatus = '';
    let turnError: string | undefined;

    await client.runTurn(
      sessionId,
      'Reply with: VERIFIED OPENROUTER STREAM',
      {
        onTokenDelta: (delta) => {
          if (delta) receivedTokens += delta.length;
        },
        onTurnComplete: (res) => {
          turnStatus = res.status;
          turnError = res.error;
        },
      },
      undefined,
      false
    );

    expect(turnStatus).toBe('done');
    expect(turnError).toBeUndefined();
    expect(receivedTokens).toBeGreaterThan(0);
  }, 45000);

  it('executes a multi-turn tool call via OpenRouter through Sentinel MCP server', async () => {
    const modelName = 'openrouter/gemini-2-5-flash';
    const sessionId = await client.createSession({
      modelName,
      instructions:
        'You are FORGE//SENTINEL. When asked to list workspace files, you MUST invoke list_workspace_files tool before answering.',
      requireToolApproval: false,
    });

    let toolCallDetected = false;
    let turnStatus = '';
    let turnError: string | undefined;
    let receivedTokens = 0;
    let fullOutput = '';

    await client.runTurn(
      sessionId,
      'Please list the workspace files using the list_workspace_files tool and describe what you found.',
      {
        onTokenDelta: (delta) => {
          if (delta) {
            receivedTokens += delta.length;
            fullOutput += delta;
          }
        },
        onToolCall: (tc) => {
          console.log('[TEST] Tool call detected:', tc.name);
          if (tc.name === 'list_workspace_files') {
            toolCallDetected = true;
          }
        },
        onTurnComplete: (res) => {
          turnStatus = res.status;
          turnError = res.error;
          console.log('[TEST] Turn complete:', res);
        },
      },
      undefined,
      false
    );

    console.log('[TEST] Full output:', fullOutput);
    console.log('[TEST] Turn error:', turnError);

    expect(toolCallDetected).toBe(true);
    expect(turnStatus).toBe('done');
    expect(turnError).toBeUndefined();
    expect(receivedTokens).toBeGreaterThan(0);
  }, 60000);
});
