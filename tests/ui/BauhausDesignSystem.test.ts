import { describe, it, expect, vi } from 'vitest';

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
      getConfiguration: () => ({ get: vi.fn() }),
    },
  };
});

import { SentinelAgentViewProvider } from '../../src/ui/SentinelAgentViewProvider.js';

describe('Bauhaus Design System UI Architecture & Contract Validation', () => {
  const mockExtensionUri = { fsPath: '/mock/path', scheme: 'file', path: '/mock/path' } as any;
  const mockTrueForge = {} as any;
  const mockPatchManager = {} as any;
  const mockFlightRecorder = {} as any;

  const provider = new SentinelAgentViewProvider(
    mockExtensionUri,
    mockTrueForge,
    mockPatchManager,
    mockFlightRecorder
  );

  const mockWebview = { cspSource: 'vscode-webview:' } as any;
  const html: string = (provider as any)._getHtmlForWebview(mockWebview);

  it('declares the authentic Bauhaus "Paper Protocol" color tokens and variables', () => {
    expect(html).toContain('--paper-warm: #F2EBDD');
    expect(html).toContain('--paper-white: #FFFFFF');
    expect(html).toContain('--paper-secondary: #EAE5D9');
    expect(html).toContain('--ink-black: #171717');
    expect(html).toContain('--signal-red: #D7263D');
    expect(html).toContain('--bauhaus-yellow: #F4B400');
    expect(html).toContain('--electric-cobalt: #1E4CA1');
    expect(html).toContain('--verified-green: #18794E');
  });

  it('renders the Bauhaus geometric symbol and official product tagline', () => {
    expect(html).toContain('FORGE//SENTINEL');
    expect(html).toContain('Understand First • Plan Intelligently • Change Precisely • Prove Everything');
    // SVG geometric shapes: square, circle, triangle
    expect(html).toContain('<rect');
    expect(html).toContain('<circle');
    expect(html).toContain('<polygon');
  });

  it('preserves all functional DOM IDs required by the extension host IPC', () => {
    const requiredIds = [
      'statusBadge',
      'modelPill',
      'modelSelect',
      'configKeysBtn',
      'stepPipeline',
      'chat',
      'stagedContainer',
      'proofContainer',
      'promptInput',
      'scanBtn',
      'cancelBtn',
      'sendBtn',
    ];

    for (const id of requiredIds) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  it('preserves all eight execution pipeline nodes', () => {
    const pipelineNodes = [
      'step-idle',
      'step-understanding',
      'step-retrieving',
      'step-searching',
      'step-planning',
      'step-staging',
      'step-testing',
      'step-proven',
    ];

    for (const node of pipelineNodes) {
      expect(html).toContain(`id="${node}"`);
    }
  });

  it('preserves all incoming IPC message handlers in the webview script', () => {
    const messageTypes = [
      'statusUpdate',
      'executionStep',
      'turnStarted',
      'turnEnded',
      'tokenDelta',
      'userMessage',
      'toolCall',
      'toolResponse',
      'contextReceipt',
      'stagedPatches',
      'proofOfChange',
      'log',
      'error',
    ];

    for (const type of messageTypes) {
      expect(html).toContain(`case '${type}':`);
    }
  });

  it('preserves all outgoing commands dispatched to extension host', () => {
    const commands = [
      'submitPrompt',
      'cancelTurn',
      'scanWorkspace',
      'acceptPatch',
      'rejectPatch',
      'revertPatch',
      'toggleHunk',
      'reviewPatchDiff',
      'selectModel',
      'openApiKeyConfig',
    ];

    for (const cmd of commands) {
      expect(html).toContain(`command: '${cmd}'`);
    }
  });

  it('contains neo-brutalist tactile button classes and hard offset shadows', () => {
    expect(html).toContain('box-shadow: var(--shadow-sm)');
    expect(html).toContain('box-shadow: var(--shadow-md)');
    expect(html).toContain('transform: translate(2px, 2px)');
  });

  it('contains responsive adaptations for narrow sidebars down to 320px', () => {
    expect(html).toContain('@media (max-width: 360px)');
    expect(html).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('includes Paper Protocol markdown typography and code block rendering styles', () => {
    expect(html).toContain('.heading-h1');
    expect(html).toContain('.heading-h2');
    expect(html).toContain('.heading-h3');
    expect(html).toContain('.message-paragraph');
    expect(html).toContain('.code-block-wrapper');
    expect(html).toContain('.code-block-header');
    expect(html).toContain('.copy-code-btn');
    expect(html).toContain('.bauhaus-table');
    expect(html).toContain('.bauhaus-quote');
    expect(html).toContain('.tool-response-box');
  });
});
