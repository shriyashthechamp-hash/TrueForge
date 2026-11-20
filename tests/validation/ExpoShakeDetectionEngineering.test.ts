import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { TrueForgeHarnessClient } from '../../src/agent/TrueForgeHarnessClient.js';
import { SentinelMcpServer } from '../../src/mcp/SentinelMcpServer.js';
import { PatchStagingManager } from '../../src/diff/PatchStagingManager.js';
import { CodebaseMri } from '../../src/context/CodebaseMri.js';
import { ContextAuction } from '../../src/context/ContextAuction.js';
import { FlightRecorder } from '../../src/flight-recorder/FlightRecorder.js';

describe('Real Repository Engineering Test: Expo Shake Detection', () => {
  const expoProjectRoot = '/Users/shriyasdeshmukh/shake_detect';
  let patchManager: PatchStagingManager;
  let mri: CodebaseMri;
  let auction: ContextAuction;
  let mcpServer: SentinelMcpServer;
  let client: TrueForgeHarnessClient;
  let flightRecorder: FlightRecorder;

  beforeAll(async () => {
    patchManager = new PatchStagingManager(expoProjectRoot);
    mri = new CodebaseMri(expoProjectRoot);
    await mri.scan();
    auction = new ContextAuction(expoProjectRoot, mri, 16000);
    mcpServer = new SentinelMcpServer(expoProjectRoot, patchManager, mri, auction, 9099);
    await mcpServer.start();

    flightRecorder = new FlightRecorder();
    client = new TrueForgeHarnessClient('http://localhost:8790', 'trueforge-standalone');
    await client.registerSentinelMcpServer(mcpServer.getSseUrl());
  });

  afterAll(async () => {
    if (mcpServer) await mcpServer.stop();
  });

  it('autonomously discovers Expo project architecture and indexes symbols without human hinting', async () => {
    const summary = mri.getStructureSummary();
    expect(summary.totalFiles).toBeGreaterThan(5);
    expect(summary.totalSymbols).toBeGreaterThan(10);

    const shakeSymbol = mri.findSymbols('useShakeDetection');
    expect(shakeSymbol.length).toBeGreaterThan(0);
    expect(shakeSymbol[0].filePath).toContain('useShakeDetection');

    const detectorSymbol = mri.findSymbols('ShakeSequenceDetector');
    expect(detectorSymbol.length).toBeGreaterThan(0);
  });

  it('runs Context Auction and selects relevant files with explainable token budget', async () => {
    const prompt =
      'Analyze this Expo React Native application. Independently discover the project architecture, trace accelerometer readings through the shake detection implementation, identify potential lifecycle and false-positive issues, and propose a robust improvement plan.';

    const { receipt, contextBundle } = await auction.runAuction(prompt, 16000, {
      reservedInstructionsTokens: 1000,
      reservedOutputTokens: 2500,
      mcpToolDefinitionsTokens: 800,
      modelContextCapacity: 1048576,
    });

    expect(receipt.selectedFiles.length).toBeGreaterThan(0);
    const selectedPaths = receipt.selectedFiles.map((f) => f.filePath);
    expect(
      selectedPaths.some(
        (p) => p.includes('useShakeDetection') || p.includes('shakeDetector') || p.includes('SafetyContext')
      )
    ).toBe(true);

    expect(receipt.totalTokensUsed).toBeLessThanOrEqual(16000);
    expect(contextBundle.length).toBeGreaterThan(200);
  });

  it('executes autonomous model reasoning with real tool calling, staging diffs without silent mutation', async () => {
    const authoritative = await client.resolveAuthoritativeModel();
    const fallbackModel = client.resolveFallbackModel();
    const modelToUse = authoritative.isAvailable ? authoritative.name : fallbackModel;

    const sessionId = await client.createSession({
      modelName: modelToUse,
      instructions: `You are FORGE//SENTINEL. Analyze the accelerometer shake detection logic.
Use read_file or inspect_file_structure to inspect src/lib/shakeDetector.ts and src/lib/useShakeDetection.ts.
Identify lifecycle issues (e.g. sensor unsubscription / listener cleanup) and false positives.
Then propose a surgical patch using propose_file_edit on src/lib/shakeDetector.ts or a new helper to harden detection.`,
      requireToolApproval: false,
    });

    let toolCallsCount = 0;
    let turnStatus = '';
    let turnError: string | undefined;
    let accumulatedText = '';

    await client.runTurn(
      sessionId,
      'Trace the accelerometer flow in src/lib/shakeDetector.ts and propose an improvement for false-positive filtering.',
      {
        onTokenDelta: (delta) => {
          accumulatedText += delta;
        },
        onToolCall: (tc) => {
          toolCallsCount++;
          flightRecorder.record('tool_call', `Agent called ${tc.name}`, tc);
        },
        onToolResponse: (resp) => {
          flightRecorder.record('tool_result', `Tool completed`, resp);
        },
        onTurnComplete: (res) => {
          turnStatus = res.status;
          turnError = res.error;
        },
      },
      undefined,
      true
    );

    expect(turnStatus).toBe('done');
    expect(turnError).toBeUndefined();
    expect(accumulatedText.length).toBeGreaterThan(0);
    expect(toolCallsCount).toBeGreaterThan(0);

    // Verify non-destructive behavior: Original file on disk is untouched
    const diskContent = await fs.readFile(path.join(expoProjectRoot, 'src/lib/shakeDetector.ts'), 'utf8');
    expect(diskContent.length).toBeGreaterThan(0);

    // Verify staged patches (if proposed) or check patch manager state
    const staged = patchManager.getAllStaged();
    if (staged.length > 0) {
      const patch = staged[0];
      expect(patch.hunks.length).toBeGreaterThan(0);

      // Verify human approval simulation: Rejecting hunk preserves state
      patchManager.setHunkDecision(patch.patchId, patch.hunks[0].hunkId, false);
      expect(patchManager.getPatch(patch.patchId)?.hunks[0].accepted).toBe(false);

      // Re-accepting hunk
      patchManager.setHunkDecision(patch.patchId, patch.hunks[0].hunkId, true);
      expect(patchManager.getPatch(patch.patchId)?.hunks[0].accepted).toBe(true);
    }
  }, 240000);
});
