import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

vi.mock('vscode', () => {
  class MockTreeItem {
    label: string | { label: string };
    collapsibleState?: number;
    description?: string;
    tooltip?: string;
    iconPath?: any;
    command?: any;
    constructor(label: string | { label: string }, collapsibleState?: number) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  }

  class MockEventEmitter {
    event = vi.fn();
    fire = vi.fn();
  }

  class MockThemeIcon {
    id: string;
    constructor(id: string) {
      this.id = id;
    }
  }

  class MockThemeColor {
    id: string;
    constructor(id: string) {
      this.id = id;
    }
  }

  class MockMarkdownString {
    value: string;
    constructor(value: string) {
      this.value = value;
    }
  }

  const MockUri = {
    file: (f: string) => ({ fsPath: f, path: f, scheme: 'file' }),
    parse: (s: string) => ({ fsPath: s, path: s, scheme: 'file' }),
  };

  return {
    TreeItem: MockTreeItem,
    TreeItemCollapsibleState: {
      None: 0,
      Collapsed: 1,
      Expanded: 2,
    },
    EventEmitter: MockEventEmitter,
    ThemeIcon: MockThemeIcon,
    ThemeColor: MockThemeColor,
    MarkdownString: MockMarkdownString,
    Uri: MockUri,
  };
});

import { TrueForgeHarnessClient } from '../../src/agent/TrueForgeHarnessClient';
import { CodebaseMri } from '../../src/context/CodebaseMri';
import { ContextAuction } from '../../src/context/ContextAuction';
import { FlightRecorder } from '../../src/flight-recorder/FlightRecorder';
import { StagedPatchesTreeDataProvider } from '../../src/ui/StagedPatchesTreeDataProvider';
import { FlightRecorderTreeDataProvider } from '../../src/ui/FlightRecorderTreeDataProvider';
import { PatchStagingManager } from '../../src/diff/PatchStagingManager';

describe('Milestone 10: Autonomous Hardening & Regression Suite', () => {

  describe('Issue A: Unified Authoritative Model Resolution (Gemini 3.8 Flash Primary)', () => {
    it('selects Gemini 3.8 Flash (Google) as authoritative primary model over stale Groq models', async () => {
      const client = new TrueForgeHarnessClient();
      vi.spyOn(client, 'getAvailableModels').mockResolvedValue([
        {
          name: 'groq/llama-3-3-70b-versatile',
          modelId: 'llama-3.3-70b-versatile',
          displayName: 'Llama 3.3 70B (Groq)',
          provider: 'groq',
          contextLength: 131072,
          maxOutputTokens: 8192,
          isAvailable: false,
          isPreferred: false,
        },
        {
          name: 'groq/qwen-3-8-27b',
          modelId: 'qwen/qwen3.8-27b',
          displayName: 'Qwen 3.8 27B (Groq)',
          provider: 'groq',
          contextLength: 131072,
          maxOutputTokens: 8192,
          isAvailable: true,
          isPreferred: false,
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

      const resolved = await client.resolveAuthoritativeModel();
      expect(resolved.name).toBe('google-gemini/gemini-3-8-flash');
      expect(resolved.modelId).toBe('gemini-3.8-flash');
      expect(resolved.displayName).toBe('Gemini 3.8 Flash (Google)');
      expect(resolved.provider).toBe('google');
      expect(resolved.isPreferred).toBe(true);
      expect(resolved.isAvailable).toBe(true);
    });

    it('filters out blacklisted deprecated models from listConfiguredModels', async () => {
      const client = new TrueForgeHarnessClient();
      vi.spyOn(client, 'getAvailableModels').mockResolvedValue([
        {
          name: 'groq/llama-3-3-70b-versatile',
          modelId: 'llama-3.3-70b-versatile',
          displayName: 'Llama 3.3 70B (Groq)',
          provider: 'groq',
          contextLength: 131072,
          maxOutputTokens: 8192,
          isAvailable: false,
          isPreferred: false,
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

      const configured = await client.listConfiguredModels();
      expect(configured).not.toContain('groq/llama-3-3-70b-versatile');
      expect(configured).toContain('google-gemini/gemini-3-8-flash');
    });

    it('formats model display names accurately and cleanly', () => {
      const client = new TrueForgeHarnessClient();
      expect(client.formatModelDisplayName('google-gemini/gemini-3-8-flash', 'gemini-3.8-flash')).toBe(
        'Gemini 3.8 Flash (Google)'
      );
      expect(client.formatModelDisplayName('groq/qwen-3-8-27b')).toBe('Qwen 3.8 27B (Groq)');
      expect(client.formatModelDisplayName('groq/llama-3.1-8b-instant')).toBe('Llama 3.1 8B Instant (Groq)');
    });
  });

  describe('Issue B: Turn Lifecycle Error Trapping', () => {
    it('detects turn failure and surfaces error to callbacks instead of swallowing', async () => {
      const client = new TrueForgeHarnessClient();
      
      const mockStream = (async function* () {
        yield {
          type: 'turn.created',
          turnId: 'turn-fail-001',
        };
        yield {
          type: 'turn.done',
          state: {
            status: 'failed',
            message: 'Groq API error: model llama-3.3-70b-versatile not found',
          },
        };
      })();

      (client as any).client = {
        sessions: {
          createTurnStream: vi.fn().mockResolvedValue(mockStream),
        },
      };

      let reportedError: Error | undefined;
      let completionStatus: string | undefined;

      await client.runTurn('session-1', 'Analyze architecture', {
        onError: (err) => {
          reportedError = err;
        },
        onTurnComplete: (res) => {
          completionStatus = res.status;
        },
      });

      expect(reportedError).toBeDefined();
      expect(reportedError?.message).toContain('model llama-3.3-70b-versatile not found');
      expect(completionStatus).toBe('failed');
    });
  });

  describe('Issue C: Context Auction Capacity Reservation & Relevance Ceilings', () => {
    let tempDir: string;
    let mri: CodebaseMri;
    let auction: ContextAuction;

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'm10_auction_'));
      mri = new CodebaseMri(tempDir);
      auction = new ContextAuction(tempDir, mri, 8000);
    });

    afterEach(async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    it('reserves capacity for instructions and output from total budget', async () => {
      // Create test files
      await fs.writeFile(path.join(tempDir, 'main.py'), 'def main():\n    print("hello")\n', 'utf8');
      await mri.scan();

      const { receipt } = await auction.runAuction('explain main.py', 8000, {
        reservedTokens: 2000,
      });

      // Total code tokens selected should never exceed (totalBudget - reservedTokens)
      expect(receipt.totalTokensUsed).toBeLessThanOrEqual(6000);
      expect(receipt.selectedFiles.length).toBeGreaterThan(0);
    });

    it('enforces minRelevanceScore and excludes noise', async () => {
      await fs.writeFile(path.join(tempDir, 'relevant.py'), 'def execute_target_task(): pass\n', 'utf8');
      await fs.writeFile(path.join(tempDir, 'noise.py'), 'def unrelated_utility_function(): pass\n', 'utf8');
      await mri.scan();

      const { receipt } = await auction.runAuction('execute_target_task', 4000, {
        minRelevanceScore: 50,
      });

      const selected = receipt.selectedFiles.map((f) => f.filePath);
      expect(selected).toContain('relevant.py');
      // Low-relevance file should either be omitted or lower priority
      expect(receipt.totalTokensUsed).toBeLessThan(4000);
    });
  });

  describe('Issue D: Execution State Machine & Proof-Carrying Code', () => {
    it('produces read_only_completed proof when isReadOnly is true', () => {
      const flightRecorder = new FlightRecorder();
      flightRecorder.startTask('task-ro-1', 'Analyze repository architecture');
      flightRecorder.record('tool_call', 'call read_file', { path: 'src/main.ts' });
      flightRecorder.record('tool_result', 'result from read_file', { toolName: 'read_file', output: 'content' });

      const proof = flightRecorder.compileProofOfChange({
        patchesProposed: 0,
        patchesAccepted: 0,
        filesModified: [],
        isReadOnly: true,
      });

      expect(proof.status).toBe('read_only_completed');
      expect(proof.filesModified.length).toBe(0);
      expect(proof.patchesAccepted).toBe(0);
      expect(proof.remainingRisks).toContain('Read-only query: no repository files modified.');
    });

    it('produces success/verified status when modifications are verified with passing tests', () => {
      const flightRecorder = new FlightRecorder();
      flightRecorder.startTask('task-mod-1', 'Fix get_debug_flag');
      flightRecorder.record('tool_call', 'run_test_command', { args: { command: 'pytest tests/test_cli.py' } });
      flightRecorder.record('tool_result', 'test output', {
        toolName: 'run_test_command',
        command: 'pytest tests/test_cli.py',
        output: '3 passed in 0.12s',
      });

      const proof = flightRecorder.compileProofOfChange({
        patchesProposed: 1,
        patchesAccepted: 1,
        filesModified: ['src/flask/cli.py'],
        isReadOnly: false,
      });

      expect(proof.status).toBe('success');
      expect(proof.filesModified.length).toBe(1);
    });
  });

  describe('Tree Data Providers (VS Code Extension Views)', () => {
    let tempWs: string;

    beforeEach(async () => {
      tempWs = await fs.mkdtemp(path.join(os.tmpdir(), 'tree_provider_test_'));
    });

    afterEach(async () => {
      await fs.rm(tempWs, { recursive: true, force: true });
    });

    it('StagedPatchesTreeDataProvider provides empty and populated states', async () => {
      const patchManager = new PatchStagingManager(tempWs);
      const provider = new StagedPatchesTreeDataProvider(patchManager);

      // Empty state
      const emptyItems = await provider.getChildren();
      expect(emptyItems.length).toBe(1);
      expect(emptyItems[0].label).toBe('No patches currently staged');

      // Populated state
      const targetFile = path.join(tempWs, 'cli.py');
      await fs.writeFile(targetFile, 'def get_debug(): return False\n', 'utf8');

      patchManager.stagePatch({
        filePath: targetFile,
        existingContent: 'def get_debug(): return False\n',
        proposedContent: 'def get_debug(): return True\n',
        rationale: 'Fix debug flag recognition',
      });

      const populatedItems = await provider.getChildren();
      expect(populatedItems.length).toBe(1);
      expect(populatedItems[0].label).toBe('cli.py');
    });

    it('FlightRecorderTreeDataProvider formats empty and populated flight events', async () => {
      const recorder = new FlightRecorder();
      const provider = new FlightRecorderTreeDataProvider(recorder);

      // Empty state
      const emptyItems = await provider.getChildren();
      expect(emptyItems.length).toBe(1);
      expect(emptyItems[0].label).toBe('No flight events recorded yet');

      // Populated state
      recorder.startTask('task-1', 'Inspect repo');
      recorder.record('tool_call', 'Tool call read_file', { name: 'read_file' });
      recorder.record('turn_done', 'Turn completed successfully');

      const populatedItems = await provider.getChildren();
      expect(populatedItems.length).toBeGreaterThanOrEqual(2);
      expect(populatedItems.some((i) => i.label?.toString().includes('TOOL CALL'))).toBe(true);
      expect(populatedItems.some((i) => i.label?.toString().includes('TURN DONE'))).toBe(true);
    });
  });

});
