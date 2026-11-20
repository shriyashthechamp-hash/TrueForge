import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';

// Mock vscode module before imports
vi.mock('vscode', () => {
  return {
    window: {
      showInformationMessage: vi.fn(),
      showErrorMessage: vi.fn(),
      showWarningMessage: vi.fn(),
      showQuickPick: vi.fn().mockResolvedValue({ label: 'Google Gemini', description: 'Configure GEMINI_API_KEY' }),
      showInputBox: vi.fn().mockResolvedValue('test-gemini-key-12345'),
      showTextDocument: vi.fn(),
      registerWebviewViewProvider: vi.fn(),
      registerTreeDataProvider: vi.fn(),
    },
    workspace: {
      getConfiguration: vi.fn().mockReturnValue({
        get: (key: string, def: any) => def,
      }),
      workspaceFolders: [{ uri: { fsPath: path.resolve(__dirname, '../../../flask') } }],
      openTextDocument: vi.fn(),
    },
    commands: {
      executeCommand: vi.fn(),
      registerCommand: vi.fn(),
    },
    Uri: {
      file: (p: string) => ({ fsPath: p, scheme: 'file', path: p }),
      parse: (p: string) => ({ fsPath: p, scheme: 'file', path: p }),
    },
    Disposable: {
      from: (...disposables: any[]) => ({ dispose: () => disposables.forEach((d) => d.dispose?.()) }),
    },
    EventEmitter: class {
      event = vi.fn();
      fire = vi.fn();
    },
    TreeItem: class {},
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  };
});

import { SentinelAgentViewProvider, logTrace, TraceRecord } from '../../src/ui/SentinelAgentViewProvider.js';
import { TrueForgeHarnessClient } from '../../src/agent/TrueForgeHarnessClient.js';
import { CodebaseMri } from '../../src/context/CodebaseMri.js';
import { ContextAuction } from '../../src/context/ContextAuction.js';
import { PatchStagingManager } from '../../src/diff/PatchStagingManager.js';
import { FlightRecorder } from '../../src/flight-recorder/FlightRecorder.js';

describe('FORGE//SENTINEL Comprehensive Interaction Matrix Integration Test', () => {
  const flaskRoot = path.resolve(__dirname, '../../../flask');
  let trueforge: TrueForgeHarnessClient;
  let mri: CodebaseMri;
  let auction: ContextAuction;
  let patchManager: PatchStagingManager;
  let flightRecorder: FlightRecorder;
  let provider: SentinelAgentViewProvider;
  let receivedMessages: any[] = [];
  let onDidReceiveMessageCallback: ((msg: any) => void) | undefined;

  beforeAll(async () => {
    trueforge = new TrueForgeHarnessClient('http://localhost:8790', 'trueforge-standalone');
    mri = new CodebaseMri(flaskRoot);
    auction = new ContextAuction(flaskRoot, mri, 16000);
    patchManager = new PatchStagingManager(flaskRoot);
    flightRecorder = new FlightRecorder();

    provider = new SentinelAgentViewProvider(
      { fsPath: '/dummy', scheme: 'file', path: '/dummy' } as any,
      flaskRoot,
      patchManager,
      mri,
      auction,
      trueforge,
      flightRecorder
    );

    const mockWebview = {
      options: {},
      html: '',
      cspSource: 'vscode-webview:',
      postMessage: async (msg: any) => {
        receivedMessages.push(msg);
        return true;
      },
      onDidReceiveMessage: (cb: (msg: any) => void) => {
        onDidReceiveMessageCallback = cb;
        return { dispose: () => {} };
      },
      asWebviewUri: (uri: any) => uri,
    };

    await provider.resolveWebviewView(
      { webview: mockWebview, visible: true } as any,
      {} as any,
      {} as any
    );
  });

  it('1. SCAN MRI: executes real codebase structural scanning and posts mriSummary', async () => {
    receivedMessages = [];
    const correlationId = 'test_scan_' + Date.now();
    
    // Simulate webview dispatching scanWorkspace
    expect(onDidReceiveMessageCallback).toBeDefined();
    await onDidReceiveMessageCallback!({
      command: 'scanWorkspace',
      correlationId,
    });

    // Verify searching execution step and mriSummary
    expect(receivedMessages.some((m) => m.type === 'executionStep' && m.step === 'searching')).toBe(true);
    const mriSummaryMsg = receivedMessages.find((m) => m.type === 'mriSummary');
    expect(mriSummaryMsg).toBeDefined();
    expect(mriSummaryMsg.summary.totalFiles).toBeGreaterThan(0);
    expect(mriSummaryMsg.summary.totalSymbols).toBeGreaterThan(0);
    expect(receivedMessages.some((m) => m.type === 'executionStep' && m.step === 'idle')).toBe(true);
  });

  it('2. CONFIG KEYS: triggers API key configuration workflow', async () => {
    const correlationId = 'test_cfg_' + Date.now();
    await onDidReceiveMessageCallback!({
      command: 'openApiKeyConfig',
      correlationId,
    });
    // Handled without throwing, logged trace
  });

  it('3. MODEL SELECTOR: switches preferred model', async () => {
    const correlationId = 'test_model_' + Date.now();
    await onDidReceiveMessageCallback!({
      command: 'selectModel',
      modelName: 'google-gemini/gemini-flash-lite-latest',
      correlationId,
    });
    expect((provider as any).userSelectedModel).toBe('google-gemini/gemini-flash-lite-latest');
  });

  it('4. CANCEL TURN: aborts execution and updates state to cancelled', async () => {
    receivedMessages = [];
    const correlationId = 'test_cancel_' + Date.now();
    await onDidReceiveMessageCallback!({
      command: 'cancelTurn',
      correlationId,
    });
    expect(receivedMessages.some((m) => m.type === 'executionStep' && m.step === 'cancelled')).toBe(true);
  });

  it('5. TASK A QUICK ACTION: triggers turn for Task A instruction', async () => {
    const prompt = "In src/flask/helpers.py, treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value treated as false.";
    const correlationId = 'task_a_' + Date.now();
    const clientTrace: TraceRecord[] = [
      { stage: 'A', stageName: 'Button click handler invoked', correlationId, timestamp: new Date().toISOString(), success: true },
      { stage: 'B', stageName: 'Prompt value successfully retrieved', correlationId, timestamp: new Date().toISOString(), success: true },
      { stage: 'C', stageName: 'Request payload constructed', correlationId, timestamp: new Date().toISOString(), success: true },
      { stage: 'D', stageName: 'Webview postMessage invoked', correlationId, timestamp: new Date().toISOString(), success: true },
    ];

    // Trigger turn via IPC handler
    receivedMessages = [];
    const turnPromise = onDidReceiveMessageCallback!({
      command: 'submitPrompt',
      text: prompt,
      correlationId,
      clientTrace,
    });

    // Abort after confirming turn started to keep test fast
    await new Promise((r) => setTimeout(r, 800));
    provider.handleCancelTurn();
    await turnPromise.catch(() => {});

    expect(receivedMessages.some((m) => m.type === 'userMessage' && m.text === prompt)).toBe(true);
  });

  it('6. TASK B QUICK ACTION: triggers turn for Task B instruction', async () => {
    const prompt = 'Add a new built-in CLI command flask config that prints the loaded application configuration as JSON.';
    const correlationId = 'task_b_' + Date.now();
    const clientTrace: TraceRecord[] = [
      { stage: 'A', stageName: 'Button click handler invoked', correlationId, timestamp: new Date().toISOString(), success: true },
      { stage: 'B', stageName: 'Prompt value successfully retrieved', correlationId, timestamp: new Date().toISOString(), success: true },
      { stage: 'C', stageName: 'Request payload constructed', correlationId, timestamp: new Date().toISOString(), success: true },
      { stage: 'D', stageName: 'Webview postMessage invoked', correlationId, timestamp: new Date().toISOString(), success: true },
    ];

    receivedMessages = [];
    const turnPromise = onDidReceiveMessageCallback!({
      command: 'submitPrompt',
      text: prompt,
      correlationId,
      clientTrace,
    });

    await new Promise((r) => setTimeout(r, 800));
    provider.handleCancelTurn();
    await turnPromise.catch(() => {});

    expect(receivedMessages.some((m) => m.type === 'userMessage' && m.text === prompt)).toBe(true);
  });
});
