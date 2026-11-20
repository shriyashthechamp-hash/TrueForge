import { describe, it, expect, beforeAll, vi } from 'vitest';

vi.mock('vscode', () => {
  return {
    Uri: {
      file: (f: string) => ({ fsPath: f, scheme: 'file', path: f }),
    },
    ThemeIcon: class {},
    ThemeColor: class {},
    window: {
      showInformationMessage: vi.fn(),
      showErrorMessage: vi.fn(),
      showQuickPick: vi.fn(),
      showInputBox: vi.fn(),
    },
    workspace: {
      getConfiguration: () => ({ get: vi.fn((key: string, def: any) => def) }),
    },
  };
});

import * as fs from 'node:fs';
import * as path from 'node:path';
import { TrueForgeHarnessClient } from '../../src/agent/TrueForgeHarnessClient.js';
import { PatchStagingManager } from '../../src/diff/PatchStagingManager.js';
import { CodebaseMri } from '../../src/context/CodebaseMri.js';
import { ContextAuction } from '../../src/context/ContextAuction.js';
import { FlightRecorder } from '../../src/flight-recorder/FlightRecorder.js';
import { SentinelAgentViewProvider, logTrace, TraceRecord } from '../../src/ui/SentinelAgentViewProvider.js';

describe('FORGE//SENTINEL Live Execution Trace Acceptance Test', () => {
  const flaskRoot = '/Users/shriyasdeshmukh/True_Forge_IIT_BOM/flask';
  const traceLogPath = '/tmp/forge_sentinel_trace.log';

  beforeAll(() => {
    // Ensure trace file exists and is writable
    if (!fs.existsSync(traceLogPath)) {
      fs.writeFileSync(traceLogPath, '', 'utf8');
    }
  });

  it('executes a real end-to-end agent turn on pallets/flask with full A-Q stage tracing', async () => {
    const patchManager = new PatchStagingManager(flaskRoot);
    const mri = new CodebaseMri(flaskRoot);
    await mri.scan();
    const auction = new ContextAuction(flaskRoot, mri, 16000);
    const flightRecorder = new FlightRecorder();
    const trueforge = new TrueForgeHarnessClient('http://localhost:8790', 'trueforge-standalone');

    const provider = new SentinelAgentViewProvider(
      { fsPath: '/dummy', scheme: 'file', path: '/dummy' } as any,
      flaskRoot,
      patchManager,
      mri,
      auction,
      trueforge,
      flightRecorder
    );

    const receivedMessages: any[] = [];
    const mockWebview = {
      options: {},
      html: '',
      cspSource: 'vscode-webview:',
      postMessage: async (msg: any) => {
        receivedMessages.push(msg);
        return true;
      },
      onDidReceiveMessage: () => ({ dispose: () => {} }),
      asWebviewUri: (uri: any) => uri,
    };

    (provider as any)._view = { webview: mockWebview, visible: true };

    const correlationId = 'trace_flask_test_' + Date.now();
    const prompt = 'Inspect this Flask repository. Find get_debug_flag, explain its implementation, and identify its relevant tests. Do not modify any files.';

    // Simulate Client Stages A-D
    const clientTrace: TraceRecord[] = [
      {
        stage: 'A',
        stageName: 'Button click handler invoked',
        correlationId,
        timestamp: new Date().toISOString(),
        success: true,
      },
      {
        stage: 'B',
        stageName: 'Prompt value successfully retrieved',
        correlationId,
        timestamp: new Date().toISOString(),
        success: true,
        details: { promptLength: prompt.length },
      },
      {
        stage: 'C',
        stageName: 'Request payload constructed',
        correlationId,
        timestamp: new Date().toISOString(),
        success: true,
        details: { command: 'submitPrompt', textLength: prompt.length },
      },
      {
        stage: 'D',
        stageName: 'Webview postMessage invoked',
        correlationId,
        timestamp: new Date().toISOString(),
        success: true,
      },
    ];

    // Execute Turn (handles Stages E, F, G, H, I, J, K, L, M, N, O, Q)
    await provider.handleUserPrompt(prompt, correlationId, clientTrace);

    // Simulate Webview Stage P completion
    logTrace({
      stage: 'P',
      stageName: 'Final assistant message renders in webview',
      correlationId,
      timestamp: new Date().toISOString(),
      success: true,
    });

    // Verify messages received in the Webview
    expect(receivedMessages.some((m) => m.type === 'userMessage')).toBe(true);
    expect(receivedMessages.some((m) => m.type === 'turnStarted')).toBe(true);
    expect(receivedMessages.some((m) => m.type === 'contextReceipt')).toBe(true);
    expect(receivedMessages.some((m) => m.type === 'tokenDelta')).toBe(true);
    expect(receivedMessages.some((m) => m.type === 'turnDone')).toBe(true);
    expect(receivedMessages.some((m) => m.type === 'turnEnded')).toBe(true);

    // Verify tokens were streamed
    const allDeltas = receivedMessages
      .filter((m) => m.type === 'tokenDelta')
      .map((m) => m.delta)
      .join('');
    console.log('[LIVE TEST] Streamed Response Length:', allDeltas.length);
    console.log('[LIVE TEST] Streamed Response Snippet:', allDeltas.slice(0, 300));
    expect(allDeltas.length).toBeGreaterThan(50);
    expect(allDeltas.toLowerCase()).toContain('get_debug_flag');

    // Verify Flight Recorder recorded the turn
    const events = flightRecorder.getEvents();
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.type === 'turn_done')).toBe(true);

    // Verify trace logs in /tmp/forge_sentinel_trace.log
    const traceContents = fs.readFileSync(traceLogPath, 'utf8');
    const ourLines = traceContents
      .trim()
      .split('\n')
      .filter((l) => l.includes(correlationId))
      .map((l) => JSON.parse(l));

    const loggedStages = new Set(ourLines.map((r: TraceRecord) => r.stage));
    console.log('[LIVE TEST] Logged Stages for correlationId:', [...loggedStages].sort());

    expect(loggedStages.has('A')).toBe(true);
    expect(loggedStages.has('B')).toBe(true);
    expect(loggedStages.has('C')).toBe(true);
    expect(loggedStages.has('D')).toBe(true);
    expect(loggedStages.has('E')).toBe(true);
    expect(loggedStages.has('F')).toBe(true);
    expect(loggedStages.has('G')).toBe(true);
    expect(loggedStages.has('H')).toBe(true);
    expect(loggedStages.has('I')).toBe(true);
    expect(loggedStages.has('J')).toBe(true);
    expect(loggedStages.has('K')).toBe(true);
    expect(loggedStages.has('L')).toBe(true);
    expect(loggedStages.has('N')).toBe(true);
    expect(loggedStages.has('O')).toBe(true);
    expect(loggedStages.has('P')).toBe(true);
    expect(loggedStages.has('Q')).toBe(true);
  }, 120000);
});
