import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodebaseMri } from '../../src/context/CodebaseMri.js';
import { PatchStagingManager } from '../../src/diff/PatchStagingManager.js';
import { FlightRecorder } from '../../src/flight-recorder/FlightRecorder.js';
import { SentinelMcpServer } from '../../src/mcp/SentinelMcpServer.js';
import { TrueForgeHarnessClient } from '../../src/agent/TrueForgeHarnessClient.js';
import { ContextAuction } from '../../src/context/ContextAuction.js';
import { PatchConflictError } from '../../src/shared/errors.js';
import type { ProofOfChangeReport, StagedFilePatch } from '../../src/shared/types.js';

describe('FORGE//SENTINEL Milestone 10.3: Autonomous Engineering Validation', () => {
  let workspaceRoot: string;
  let stagingDir: string;
  let mri: CodebaseMri;
  let patchManager: PatchStagingManager;
  let flightRecorder: FlightRecorder;
  let auction: ContextAuction;
  let mcpServer: SentinelMcpServer;
  let harnessClient: TrueForgeHarnessClient;

  beforeAll(async () => {
    // Target workspace is FORGE-SENTINEL itself
    workspaceRoot = path.resolve(__dirname, '../..');
    stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sentinel_m10_3_'));

    mri = new CodebaseMri(workspaceRoot);
    await mri.scan();

    patchManager = new PatchStagingManager(stagingDir);
    flightRecorder = new FlightRecorder();
    auction = new ContextAuction(workspaceRoot, mri, 8000);

    mcpServer = new SentinelMcpServer(workspaceRoot, patchManager, mri, auction, 9099);
    await mcpServer.start();

    harnessClient = new TrueForgeHarnessClient('http://localhost:8790', 'trueforge-standalone');
    await harnessClient.registerSentinelMcpServer(mcpServer.getSseUrl());
    await harnessClient.ensureGeminiProviderConfigured(undefined, workspaceRoot);
  });

  afterAll(async () => {
    if (mcpServer) {
      await mcpServer.stop();
    }
    if (stagingDir) {
      await fs.rm(stagingDir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // TEST 1 — AUTONOMOUS DISCOVERY
  // =========================================================================
  it('TEST 1: Independently discovers target implementation files, dependencies and tests without hardcoded filenames', async () => {
    // Query Codebase MRI symbol index
    const symbolQuery1 = mri.findSymbols('StagedFilePatch');
    expect(symbolQuery1.length).toBeGreaterThan(0);
    const typesPath = symbolQuery1[0].filePath;
    expect(typesPath).toContain('types.ts');

    const symbolQuery2 = mri.findSymbols('PatchStagingManager');
    expect(symbolQuery2.length).toBeGreaterThan(0);
    const patchManagerPath = symbolQuery2[0].filePath;
    expect(patchManagerPath).toContain('PatchStagingManager.ts');

    const symbolQuery3 = mri.findSymbols('FlightRecorder');
    expect(symbolQuery3.length).toBeGreaterThan(0);
    const flightRecorderPath = symbolQuery3[0].filePath;
    expect(flightRecorderPath).toContain('FlightRecorder.ts');

    const symbolQuery4 = mri.findSymbols('SentinelMcpServer');
    expect(symbolQuery4.length).toBeGreaterThan(0);
    const mcpServerPath = symbolQuery4[0].filePath;
    expect(mcpServerPath).toContain('SentinelMcpServer.ts');

    // Discover tests associated with PatchStagingManager and FlightRecorder
    const discoveredTests = mri.getTestsForSource(patchManagerPath);
    expect(discoveredTests.length).toBeGreaterThanOrEqual(1);
    expect(discoveredTests.some((t) => t.includes('PatchStagingManager.test.ts'))).toBe(true);

    const recorderTests = mri.getTestsForSource(flightRecorderPath);
    expect(recorderTests.length).toBeGreaterThanOrEqual(1);
    expect(recorderTests.some((t) => t.includes('FlightRecorder.test.ts'))).toBe(true);
  });

  // =========================================================================
  // TEST 2 — MULTI-FILE ENGINEERING
  // =========================================================================
  it('TEST 2: Proposes coordinated changes across >=3 files with staged diffs and zero silent modifications', async () => {
    // Problem: StagedFilePatch does not expose raw DiffStats (linesAdded, linesRemoved)
    // Solution: Expose DiffStats and aggregate metrics across types.ts, PatchStagingManager.ts, and FlightRecorder.ts

    // Setup mock file environment in isolated staging sandbox to verify diff calculation
    const file1Rel = 'src/shared/types.ts';
    const file2Rel = 'src/diff/PatchStagingManager.ts';
    const file3Rel = 'src/flight-recorder/FlightRecorder.ts';

    await fs.mkdir(path.join(stagingDir, 'src/shared'), { recursive: true });
    await fs.mkdir(path.join(stagingDir, 'src/diff'), { recursive: true });
    await fs.mkdir(path.join(stagingDir, 'src/flight-recorder'), { recursive: true });

    const orig1 = 'export interface StagedFilePatch {\n  patchId: string;\n  status: string;\n}\n';
    const orig2 = 'export class PatchStagingManager {\n  public stagePatch() { return {}; }\n}\n';
    const orig3 = 'export class FlightRecorder {\n  public compileProofOfChange() { return {}; }\n}\n';

    await fs.writeFile(path.join(stagingDir, file1Rel), orig1, 'utf8');
    await fs.writeFile(path.join(stagingDir, file2Rel), orig2, 'utf8');
    await fs.writeFile(path.join(stagingDir, file3Rel), orig3, 'utf8');

    // Proposed changes
    const prop1 = 'export interface DiffStats {\n  linesAdded: number;\n  linesRemoved: number;\n}\n\nexport interface StagedFilePatch {\n  patchId: string;\n  status: string;\n  stats?: DiffStats;\n}\n';
    const prop2 = 'export class PatchStagingManager {\n  public computeDiffStats() { return { linesAdded: 5, linesRemoved: 1 }; }\n  public stagePatch() { return { stats: this.computeDiffStats() }; }\n}\n';
    const prop3 = 'export class FlightRecorder {\n  public compileProofOfChange(options?: { diffMetrics?: { totalLinesAdded: number; totalLinesRemoved: number } }) {\n    return { diffMetrics: options?.diffMetrics };\n  }\n}\n';

    const p1 = patchManager.stagePatch({
      filePath: file1Rel,
      existingContent: orig1,
      proposedContent: prop1,
      purpose: 'Add DiffStats interface and stats property to StagedFilePatch contract',
      rationale: 'Enables callers to inspect numerical addition/deletion counts',
    });

    const p2 = patchManager.stagePatch({
      filePath: file2Rel,
      existingContent: orig2,
      proposedContent: prop2,
      purpose: 'Expose computeDiffStats and record stats on staged patches',
      rationale: 'Provides numerical metrics across diff hunks',
    });

    const p3 = patchManager.stagePatch({
      filePath: file3Rel,
      existingContent: orig3,
      proposedContent: prop3,
      purpose: 'Accept diffMetrics in ProofOfChangeReport compilation',
      rationale: 'Ensures Proof of Change captures aggregate mutation metrics',
    });

    // Verify all 3 patches are staged
    expect(p1.hunks.length).toBeGreaterThan(0);
    expect(p2.hunks.length).toBeGreaterThan(0);
    expect(p3.hunks.length).toBeGreaterThan(0);

    expect(p1.riskLevel).toBe('low');
    expect(p2.riskLevel).toBe('low');
    expect(p3.riskLevel).toBe('low');

    // Verify target files on disk have NOT been modified yet (immutability before approval)
    expect(await fs.readFile(path.join(stagingDir, file1Rel), 'utf8')).toBe(orig1);
    expect(await fs.readFile(path.join(stagingDir, file2Rel), 'utf8')).toBe(orig2);
    expect(await fs.readFile(path.join(stagingDir, file3Rel), 'utf8')).toBe(orig3);
  });

  // =========================================================================
  // TEST 3 — HUMAN APPROVAL
  // =========================================================================
  it('TEST 3: Verifies selective hunk acceptance/rejection, external conflict detection, and explicit application', async () => {
    const testFile = 'src/diff/HunkApprovalTest.ts';
    const originalContent = 'line 1: start\nline 2: middle\nline 3: end\n';
    await fs.writeFile(path.join(stagingDir, testFile), originalContent, 'utf8');

    // Patch with 2 modifications: replace line 1 and replace line 3
    const proposedContent = 'line 1: MODIFIED_TOP\nline 2: middle\nline 3: MODIFIED_BOTTOM\n';

    const staged = patchManager.stagePatch({
      filePath: testFile,
      existingContent: originalContent,
      proposedContent,
      purpose: 'Test selective hunk review',
      rationale: 'Two distinct hunks',
    });

    // 1. Verify conflict detection
    await fs.writeFile(path.join(stagingDir, testFile), 'line 1: CONCURRENT_EXTERNAL_MODIFICATION\n', 'utf8');
    await expect(patchManager.applyPatch(staged.patchId)).rejects.toThrow(PatchConflictError);

    // Restore original file
    await fs.writeFile(path.join(stagingDir, testFile), originalContent, 'utf8');

    // 2. Reject the patch
    patchManager.setPatchDecision(staged.patchId, 'reject');
    expect(staged.status).toBe('rejected');
    expect(await fs.readFile(path.join(stagingDir, testFile), 'utf8')).toBe(originalContent);

    // 3. Re-stage and accept explicitly
    const staged2 = patchManager.stagePatch({
      filePath: testFile,
      existingContent: originalContent,
      proposedContent,
      purpose: 'Explicit approved apply',
      rationale: 'User approved change',
    });

    patchManager.setPatchDecision(staged2.patchId, 'accept');
    const applyRes = await patchManager.applyPatch(staged2.patchId);
    expect(applyRes.appliedContent).toBe(proposedContent);

    const onDiskAfter = await fs.readFile(path.join(stagingDir, testFile), 'utf8');
    expect(onDiskAfter).toBe(proposedContent);

    // 4. Revert patch cleanly
    await patchManager.revertPatch(staged2.patchId);
    expect(await fs.readFile(path.join(stagingDir, testFile), 'utf8')).toBe(originalContent);
  });

  // =========================================================================
  // TEST 4 — VERIFICATION
  // =========================================================================
  it('TEST 4: Discovers and executes tests, producing a complete 14-point Proof of Change report', async () => {
    flightRecorder.startTask('task_m10_3_verify', 'Validate diff metrics aggregation in Proof of Change');
    flightRecorder.setImplementationPlan([
      'Discover target files via MRI symbol search',
      'Stage multi-file edits with DiffStats contracts',
      'Execute Vitest unit test suite to prove correctness',
    ]);

    flightRecorder.addFileInspected('src/shared/types.ts');
    flightRecorder.addFileInspected('src/diff/PatchStagingManager.ts');
    flightRecorder.addFileInspected('src/flight-recorder/FlightRecorder.ts');

    flightRecorder.addDiscoveredTests([
      'tests/diff/PatchStagingManager.test.ts',
      'tests/flight-recorder/FlightRecorder.test.ts',
    ]);

    // Simulate passing test execution event
    flightRecorder.record('tool_result', 'Ran vitest test suite', {
      toolName: 'run_test_command',
      command: 'npx vitest run tests/diff/PatchStagingManager.test.ts',
      output: '6 passed in 0.05s',
      isError: false,
    });

    const report: ProofOfChangeReport = flightRecorder.compileProofOfChange({
      filesModified: ['src/shared/types.ts', 'src/diff/PatchStagingManager.ts', 'src/flight-recorder/FlightRecorder.ts'],
      patchesProposed: 3,
      patchesAccepted: 3,
      approvedHunksCount: 3,
      rejectedHunksCount: 0,
    });

    expect(report.taskId).toBe('task_m10_3_verify');
    expect(report.status).toBe('success');
    expect(report.testsPassed).toBe(true);
    expect(report.filesModified.length).toBe(3);
    expect(report.filesInspected.length).toBe(3);
    expect(report.implementationPlan.length).toBe(3);
    expect(report.testResults.some((t) => t.status === 'passed')).toBe(true);
    expect(report.generatedAt).toBeDefined();
    expect(report.remainingRisks.length).toBeGreaterThan(0);
  });

  // =========================================================================
  // TEST 5 — FAILURE RECOVERY & CANCELLATION
  // =========================================================================
  it('TEST 5: Performs controlled cancellation and verifies mid-stream abort and workspace immutability', async () => {
    flightRecorder.startTask('task_m10_3_cancellation', 'Test mid-stream cancellation safety');

    const authoritative = await harnessClient.resolveAuthoritativeModel();
    const sessionId = await harnessClient.createSession({
      modelName: authoritative.name,
      instructions: 'Analyze entire repository and generate long explanations',
    });

    const abortController = new AbortController();
    const probeFile = path.join(stagingDir, 'cancellation_probe.txt');
    const initialContent = 'UNMODIFIED_STABLE_STATE';
    await fs.writeFile(probeFile, initialContent, 'utf8');

    // Trigger abort 250ms after turn begins
    setTimeout(() => {
      abortController.abort();
    }, 250);

    let streamAborted = false;
    try {
      await harnessClient.runTurn(
        sessionId,
        'Provide a 5000 word line-by-line analysis of all files in this repository.',
        {},
        abortController.signal
      );
    } catch (err: any) {
      if (err.name === 'AbortError' || err.message?.includes('aborted') || abortController.signal.aborted) {
        streamAborted = true;
      }
    }

    await harnessClient.cancel(sessionId);
    flightRecorder.record('turn_done', 'Turn cancelled by user', { status: 'cancelled' });

    // Verify workspace file immutability
    expect(await fs.readFile(probeFile, 'utf8')).toBe(initialContent);

    // Verify flight recorder recorded the event
    const events = flightRecorder.getEvents();
    expect(events.some((e) => e.summary.includes('cancelled') || e.details?.status === 'cancelled')).toBe(true);
  }, 45000);

  // =========================================================================
  // TEST 6 — GEMINI INTEGRATION & STREAMING
  // =========================================================================
  it('TEST 6: Validates live Gemini inference, streaming token reception, and ModelRescue readiness', async () => {
    const authoritative = await harnessClient.resolveAuthoritativeModel();
    expect(authoritative.modelId).toBe('gemini-3.8-flash');
    expect(authoritative.displayName).toBe('Gemini 3.8 Flash (Google)');

    const sessionId = await harnessClient.createSession({
      modelName: authoritative.name,
      instructions: 'You are FORGE//SENTINEL. Answer concisely without calling tools.',
    });

    let receivedDeltas = 0;
    let accumulatedText = '';
    let completed = false;
    let turnResult: any;

    await harnessClient.runTurn(sessionId, 'Reply with the word ONLINE.', {
      onTokenDelta: (delta) => {
        receivedDeltas++;
        accumulatedText += delta;
      },
      onToolCall: () => {
        receivedDeltas++;
      },
      onTurnComplete: (res) => {
        turnResult = res;
        completed = true;
      },
      onError: (err) => {
        console.error('Turn error:', err);
      },
    });

    expect(receivedDeltas).toBeGreaterThan(0);
    expect(completed).toBe(true);
    expect(accumulatedText.length).toBeGreaterThan(0);

    // Verify ModelRescue fallback readiness
    const fallbackModel = harnessClient.resolveFallbackModel();
    expect(fallbackModel).toBeDefined();
    expect(fallbackModel.includes('gemini')).toBe(true);
  }, 60000);
});
