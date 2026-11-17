import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { TrueForgeHarnessClient } from '../../src/agent/TrueForgeHarnessClient.js';
import { SentinelMcpServer } from '../../src/mcp/SentinelMcpServer.js';
import { PatchStagingManager } from '../../src/diff/PatchStagingManager.js';
import { CodebaseMri } from '../../src/context/CodebaseMri.js';
import { ContextAuction } from '../../src/context/ContextAuction.js';

describe('Regression: Gemini HTTP 400 Multi-Turn Tool Replay Fix', () => {
  it('prioritizes native google-gemini provider models over custom openai-compatible google models', async () => {
    const client = new TrueForgeHarnessClient();
    vi.spyOn(client, 'getAvailableModels').mockResolvedValue([
      {
        name: 'google/gemini-3-8-flash',
        modelId: 'gemini-3.8-flash',
        displayName: 'Gemini 3.8 Flash (Google)',
        provider: 'google', // custom openai-compatible
        contextLength: 1048576,
        maxOutputTokens: 65536,
        isAvailable: true,
        isPreferred: true,
      },
      {
        name: 'google-gemini/gemini-3-8-flash',
        modelId: 'gemini-3.8-flash',
        displayName: 'Gemini 3.8 Flash (Google)',
        provider: 'google',
        contextLength: 1048576,
        maxOutputTokens: 65536,
        isAvailable: true,
        isPreferred: true,
      },
    ]);

    const authoritative = await client.resolveAuthoritativeModel();
    // Must pick native google-gemini to ensure thought_signature is preserved during multi-turn tool execution
    expect(authoritative.name).toBe('google-gemini/gemini-3-8-flash');
  });

  it('resolves fallback models through native google-gemini provider', () => {
    const client = new TrueForgeHarnessClient();
    TrueForgeHarnessClient.quotaExhaustedModels.clear();

    const fallback = client.resolveFallbackModel();
    expect(fallback).toBe('google-gemini/gemini-flash-lite-latest');
    expect(fallback.startsWith('google-gemini/')).toBe(true);

    TrueForgeHarnessClient.quotaExhaustedModels.add('gemini-flash-lite-latest');
    const fallback2 = client.resolveFallbackModel();
    expect(fallback2).toBe('google-gemini/gemini-3-5-flash');

    TrueForgeHarnessClient.quotaExhaustedModels.add('gemini-3.5-flash');
    const fallback3 = client.resolveFallbackModel();
    expect(fallback3).toBe('google-gemini/gemini-2-5-flash');

    TrueForgeHarnessClient.quotaExhaustedModels.clear();
  });

  describe('Live Integration: Multi-turn tool replay with thought_signature', () => {
    let tempDir: string;
    let patchManager: PatchStagingManager;
    let mri: CodebaseMri;
    let auction: ContextAuction;
    let mcpServer: SentinelMcpServer;
    let client: TrueForgeHarnessClient;

    beforeAll(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tf_400_repro_'));
      await fs.writeFile(path.join(tempDir, 'package.json'), JSON.stringify({ name: 'sample-app', version: '1.0.0' }, null, 2));
      await fs.writeFile(path.join(tempDir, 'README.md'), '# Sample App');

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

    it('successfully executes a multi-turn tool call turn without HTTP 400 error', async () => {
      // Use fallback model google-gemini/gemini-flash-lite-latest which has verified quota
      const modelName = 'google-gemini/gemini-flash-lite-latest';
      const sessionId = await client.createSession({
        modelName,
        instructions: 'You are FORGE//SENTINEL. When asked to list workspace files, you MUST invoke list_workspace_files tool before answering.',
        requireToolApproval: false,
      });

      let toolCallDetected = false;
      let turnStatus = '';
      let turnError: string | undefined;
      let receivedTokens = 0;

      await client.runTurn(
        sessionId,
        'Please list the workspace files using the list_workspace_files tool and describe what you found.',
        {
          onTokenDelta: (delta) => {
            if (delta) receivedTokens++;
          },
          onToolCall: (tc) => {
            if (tc.name === 'list_workspace_files') {
              toolCallDetected = true;
            }
          },
          onTurnComplete: (res) => {
            turnStatus = res.status;
            turnError = res.error;
          },
        },
        undefined,
        false
      );

      expect(toolCallDetected).toBe(true);
      expect(turnStatus).toBe('done');
      expect(turnError).toBeUndefined();
      expect(receivedTokens).toBeGreaterThan(0);
    }, 60000);
  });
});
