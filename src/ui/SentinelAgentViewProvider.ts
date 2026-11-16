import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { TrueForgeHarnessClient } from '../agent/TrueForgeHarnessClient.js';
import type { CodebaseMri } from '../context/CodebaseMri.js';
import type { ContextAuction } from '../context/ContextAuction.js';
import type { PatchStagingManager } from '../diff/PatchStagingManager.js';
import type { FlightRecorder } from '../flight-recorder/FlightRecorder.js';
import type { StagedPatchesTreeDataProvider } from './StagedPatchesTreeDataProvider.js';
import type { FlightRecorderTreeDataProvider } from './FlightRecorderTreeDataProvider.js';
import type { AgentExecutionStep, ProofOfChangeReport } from '../shared/types.js';
import { ModelRescue } from '../resilience/ModelRescue.js';

export class SentinelAgentViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'forge-sentinel.agentPanel';
  private _view?: vscode.WebviewView;
  private currentAbortController?: AbortController;
  private activeSessionId?: string;
  private readonly modelRescue = new ModelRescue(2);
  private conversationHistoryTokens = 0;
  private recordedToolResults: Array<{ id: string; toolName?: string; result: unknown }> = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly workspaceRoot: string,
    private readonly patchManager: PatchStagingManager,
    private readonly mri: CodebaseMri,
    private readonly auction: ContextAuction,
    private readonly trueforge: TrueForgeHarnessClient,
    private readonly flightRecorder: FlightRecorder,
    private readonly stagedPatchesTreeProvider?: StagedPatchesTreeDataProvider,
    private readonly flightRecorderTreeProvider?: FlightRecorderTreeDataProvider
  ) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case 'submitPrompt': {
          await this.handleUserPrompt(message.text);
          break;
        }
        case 'cancelTurn': {
          this.handleCancelTurn();
          break;
        }
        case 'scanWorkspace': {
          await this.handleScanWorkspace();
          break;
        }
        case 'acceptPatch': {
          await this.handlePatchDecision(message.patchId, 'accept');
          break;
        }
        case 'rejectPatch': {
          await this.handlePatchDecision(message.patchId, 'reject');
          break;
        }
        case 'revertPatch': {
          await this.handleRevertPatch(message.patchId);
          break;
        }
        case 'toggleHunk': {
          this.patchManager.setHunkDecision(message.patchId, message.hunkId, message.accepted);
          this.refreshStagedPatchesUI();
          break;
        }
        case 'reviewPatchDiff': {
          await this.handleReviewDiff(message.patchId);
          break;
        }
        case 'refreshStatus': {
          await this.updateConnectionStatus();
          break;
        }
      }
    });

    this.updateConnectionStatus();
  }

  private async updateConnectionStatus(): Promise<void> {
    try {
      const health = await this.trueforge.checkHealth();
      const authoritative = await this.trueforge.resolveAuthoritativeModel();
      const models = await this.trueforge.getAvailableModels();
      this._view?.webview.postMessage({
        type: 'statusUpdate',
        connected: true,
        version: health.version ?? '0.0.0',
        activeModel: authoritative.displayName,
        modelName: authoritative.name,
        models: models.map((m) => ({
          name: m.name,
          displayName: m.displayName,
          isAvailable: m.isAvailable,
        })),
      });
    } catch {
      this._view?.webview.postMessage({
        type: 'statusUpdate',
        connected: false,
        error: 'TrueForge daemon unreachable on localhost:8790',
      });
    }
  }

  private async handleScanWorkspace(): Promise<void> {
    this.postExecutionStep('searching');
    this._view?.webview.postMessage({ type: 'log', message: 'Running Codebase MRI structural scan...' });
    await this.mri.scan();
    const summary = this.mri.getStructureSummary();
    this._view?.webview.postMessage({
      type: 'mriSummary',
      summary,
    });
    this._view?.webview.postMessage({
      type: 'log',
      message: `Codebase MRI scan complete: ${summary.totalFiles} files, ${summary.totalSymbols} symbols indexed.`,
    });
    this.postExecutionStep('idle');
  }

  private postExecutionStep(step: AgentExecutionStep): void {
    this._view?.webview.postMessage({
      type: 'executionStep',
      step,
    });
  }

  public async handleUserPrompt(promptText: string): Promise<void> {
    if (!promptText || promptText.trim() === '') return;

    this.currentAbortController = new AbortController();
    const taskId = `task_${Date.now()}`;
    this.flightRecorder.startTask(taskId, promptText);

    this._view?.webview.postMessage({ type: 'userMessage', text: promptText });
    this._view?.webview.postMessage({ type: 'turnStarted' });
    this.postExecutionStep('understanding');

    let accumulatedTokens = 0;

    try {
      this.postExecutionStep('retrieving');
      this._view?.webview.postMessage({ type: 'log', message: 'Context Auction: Evaluating repository relevance and token budget...' });

      const config = vscode.workspace.getConfiguration('forgeSentinel');
      const configuredBudget = config.get<number>('contextBudgetTokens', 16000);

      await this.trueforge.ensureGeminiProviderConfigured(undefined, this.workspaceRoot);
      const authoritative = await this.trueforge.resolveAuthoritativeModel();
      this._view?.webview.postMessage({
        type: 'statusUpdate',
        connected: true,
        activeModel: authoritative.displayName,
        modelName: authoritative.name,
      });

      const effectiveBudget = Math.min(configuredBudget, authoritative.contextLength || 1048576);
      const reservedInstructions = Math.min(1200, Math.round(effectiveBudget * 0.15));
      const reservedOutput = Math.min(2500, Math.round(effectiveBudget * 0.25));

      const { receipt, contextBundle } = await this.auction.runAuction(promptText, effectiveBudget, {
        reservedInstructionsTokens: reservedInstructions,
        reservedOutputTokens: reservedOutput,
        conversationHistoryTokens: this.conversationHistoryTokens,
        mcpToolDefinitionsTokens: 800,
        toolResultsHistory: this.recordedToolResults,
        modelContextCapacity: authoritative.contextLength || 1048576,
        maxSelectedFiles: 8,
        minRelevanceScore: 30,
      });

      this.flightRecorder.setContextSelectionMetadata(
        receipt.selectedFiles.map((f) => ({
          filePath: f.filePath,
          tokens: f.estimatedTokens,
          score: f.score,
        }))
      );

      this._view?.webview.postMessage({
        type: 'contextReceipt',
        receipt,
      });

      this.postExecutionStep('planning');
      this._view?.webview.postMessage({
        type: 'log',
        message: `Model resolved: ${authoritative.displayName} [${authoritative.modelId}]. Starting TrueForge agent turn...`,
      });

      if (!this.activeSessionId) {
        this.activeSessionId = await this.trueforge.createSession({
          modelName: authoritative.name,
          instructions: `You are FORGE//SENTINEL, an expert autonomous coding agent.
Core philosophy: "Understand First. Plan Intelligently. Change Precisely. Prove Everything."
To inspect code: search_workspace, find_symbol, read_file, inspect_file_structure, list_workspace_files.
To stage changes: propose_file_edit, propose_multi_file_edit, get_staged_patches.
To run tests: run_test_command.
Always explain the purpose, rationale, and expected impact of any changes before staging.`,
        });
      }

      const fullPrompt = `${promptText}\n\n=== RELEVANT CONTEXT (RETRIEVED VIA CONTEXT AUCTION) ===\n${contextBundle}`;

      for (let attempt = 0; attempt < 3; attempt++) {
        let shouldRetryTransient = false;
        let transientErrorObj: Error | undefined;
        let hasExecutedSideEffectTools = false;

        await this.trueforge.runTurn(
          this.activeSessionId,
          fullPrompt,
          {
            onTokenDelta: (delta) => {
              accumulatedTokens += delta.length;
              this._view?.webview.postMessage({ type: 'tokenDelta', delta });
            },
            onToolCall: (call) => {
              if (
                call.name.includes('propose') ||
                call.name.includes('apply') ||
                call.name.includes('revert') ||
                call.name.includes('run_terminal')
              ) {
                hasExecutedSideEffectTools = true;
              }
              if (call.name.includes('search') || call.name.includes('find') || call.name.includes('list')) {
                this.postExecutionStep('searching');
              } else if (call.name.includes('read') || call.name.includes('inspect')) {
                this.postExecutionStep('inspecting');
              } else if (call.name.includes('propose')) {
                this.postExecutionStep('staging');
              } else if (call.name.includes('test')) {
                this.postExecutionStep('testing');
              }
              this._view?.webview.postMessage({ type: 'toolCall', call });
              this.flightRecorder.record('tool_call', `Agent invoked tool: ${call.name}`, { ...call });
              this.flightRecorderTreeProvider?.refresh();
            },
            onToolResponse: (resp) => {
              this.recordedToolResults.push({ id: resp.id, result: resp.result });
              this._view?.webview.postMessage({ type: 'toolResponse', resp });
              this.flightRecorder.record('tool_result', `Tool completed`, { ...resp });
              this.refreshStagedPatchesUI();
              this.flightRecorderTreeProvider?.refresh();
            },
            onTurnComplete: (result) => {
              if (result.error) {
                const rawErr = new Error(result.error);
                if (this.modelRescue.isTransientError(rawErr) && !hasExecutedSideEffectTools && attempt < 2) {
                  shouldRetryTransient = true;
                  transientErrorObj = rawErr;
                  return;
                }
              }

              const isError = result.status === 'failed' || Boolean(result.error);
              const staged = this.patchManager.getAllStaged();
              const applied = staged.filter((p) => p.status === 'applied');

              if (isError) {
                this.postExecutionStep('failed');
                const enhanced = this.modelRescue.enhanceError(
                  new Error(result.error || 'Agent turn failed during execution'),
                  'Gemini Agent Turn'
                );
                this._view?.webview.postMessage({
                  type: 'error',
                  message: enhanced.message,
                });
                this._view?.webview.postMessage({ type: 'turnDone', result });
                this.compileAndSendProofOfChange(promptText, taskId, false);
                return;
              }

              this.conversationHistoryTokens +=
                this.auction.estimateTokens(promptText) + Math.ceil(accumulatedTokens / 4);

              if (staged.length > 0) {
                if (applied.length > 0) {
                  this.postExecutionStep('proven');
                } else {
                  this.postExecutionStep('staging');
                }
              } else {
                // Read-only analysis turn with no staged file mutations
                if (accumulatedTokens > 0) {
                  this.postExecutionStep('completed');
                } else {
                  this.postExecutionStep('unverified');
                  this._view?.webview.postMessage({
                    type: 'log',
                    message: 'Notice: Agent completed turn without generating response tokens or patch proposals.',
                  });
                }
              }

              this._view?.webview.postMessage({ type: 'turnDone', result });
              this.compileAndSendProofOfChange(promptText, taskId, staged.length === 0);
            },
          },
          this.currentAbortController.signal
        );

        if (shouldRetryTransient && attempt < 2) {
          const providerWait = this.modelRescue.extractRetryDelayMs(transientErrorObj);
          const baseBackoff = 2000 * Math.pow(2, attempt);
          const jitter = Math.round(Math.random() * 800);
          const waitMs = providerWait ? Math.min(providerWait + jitter, 20000) : Math.min(baseBackoff + jitter, 15000);
          const cleanReason = this.modelRescue.sanitizeCredentials(transientErrorObj?.message ?? 'Transient provider error');
          this._view?.webview.postMessage({
            type: 'log',
            message: `Transient provider status encountered (${cleanReason}). ModelRescue bounded retry ${attempt + 1}/2 in ${(waitMs / 1000).toFixed(1)}s...`,
          });
          await this.modelRescue.sleepWithAbort(waitMs, this.currentAbortController.signal);
          continue;
        }
        break;
      }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        this.postExecutionStep('cancelled');
        this._view?.webview.postMessage({ type: 'log', message: 'Turn was cancelled by user. Workspace state and conversation history fully preserved.' });
      } else {
        this.postExecutionStep('failed');
        const enhanced = this.modelRescue.enhanceError(err, 'Agent Execution');
        this._view?.webview.postMessage({ type: 'error', message: enhanced.message });
      }
    } finally {
      this._view?.webview.postMessage({ type: 'turnEnded' });
      this.currentAbortController = undefined;
    }
  }

  private handleCancelTurn(): void {
    if (this.currentAbortController) {
      this.currentAbortController.abort();
    }
    if (this.activeSessionId) {
      this.trueforge.cancel(this.activeSessionId);
    }
    this.postExecutionStep('cancelled');
    this._view?.webview.postMessage({ type: 'log', message: 'Cancellation signal sent.' });
  }

  private refreshStagedPatchesUI(): void {
    const patches = this.patchManager.getAllStaged();
    this._view?.webview.postMessage({
      type: 'stagedPatches',
      patches: patches.map((p) => ({
        patchId: p.patchId,
        filePath: p.filePath,
        status: p.status,
        purpose: p.purpose,
        rationale: p.rationale,
        expectedImpact: p.expectedImpact,
        riskLevel: p.riskLevel,
        hunks: p.hunks,
      })),
    });
    this.stagedPatchesTreeProvider?.refresh();
  }

  private async handleReviewDiff(patchId: string): Promise<void> {
    const patch = this.patchManager.getPatch(patchId);
    if (!patch) return;

    const fileUri = vscode.Uri.file(patch.absolutePath);
    const tempProposedUri = vscode.Uri.parse(`untitled:${patch.filePath}.proposed`);

    const doc = await vscode.workspace.openTextDocument(tempProposedUri);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(tempProposedUri, new vscode.Range(0, 0, doc.lineCount, 0), patch.proposedContent);
    await vscode.workspace.applyEdit(edit);

    await vscode.commands.executeCommand(
      'vscode.diff',
      fileUri,
      tempProposedUri,
      `Sentinel Review: ${path.basename(patch.filePath)} (Proposed Diff)`
    );
  }

  private async handlePatchDecision(patchId: string, decision: 'accept' | 'reject'): Promise<void> {
    const patch = this.patchManager.getPatch(patchId);
    if (!patch) return;

    if (decision === 'accept') {
      try {
        await this.patchManager.applyPatch(patchId);
        vscode.window.showInformationMessage(`FORGE//SENTINEL: Applied surgical patch to "${patch.filePath}".`);
        this.flightRecorder.record('patch_applied', `Applied patch ${patchId}`, { filePath: patch.filePath });
      } catch (err: any) {
        vscode.window.showErrorMessage(`Apply failed: ${err.message}`);
      }
    } else {
      this.patchManager.setPatchDecision(patchId, 'reject');
      vscode.window.showInformationMessage(`FORGE//SENTINEL: Rejected patch for "${patch.filePath}".`);
    }

    this.refreshStagedPatchesUI();
    this.compileAndSendProofOfChange('', patchId);
  }

  private async handleRevertPatch(patchId: string): Promise<void> {
    try {
      await this.patchManager.revertPatch(patchId);
      vscode.window.showInformationMessage(`FORGE//SENTINEL: Reverted patch ${patchId}.`);
      this.refreshStagedPatchesUI();
      this.compileAndSendProofOfChange('', patchId);
    } catch (err: any) {
      vscode.window.showErrorMessage(`Revert failed: ${err.message}`);
    }
  }

  private compileAndSendProofOfChange(instruction: string, taskId: string, isReadOnly = false): void {
    const staged = this.patchManager.getAllStaged();
    const applied = staged.filter((p) => p.status === 'applied');
    const approvedHunks = staged.reduce((acc, p) => acc + p.hunks.filter((h) => h.accepted).length, 0);
    const rejectedHunks = staged.reduce((acc, p) => acc + p.hunks.filter((h) => !h.accepted).length, 0);

    const report: ProofOfChangeReport = this.flightRecorder.compileProofOfChange({
      filesModified: applied.map((p) => p.filePath),
      patchesProposed: staged.length,
      patchesAccepted: applied.length,
      approvedHunksCount: approvedHunks,
      rejectedHunksCount: rejectedHunks,
      isReadOnly,
    });

    this._view?.webview.postMessage({
      type: 'proofOfChange',
      report,
    });

    this._view?.webview.postMessage({
      type: 'timelineEvents',
      events: this.flightRecorder.getEvents(),
    });

    this.flightRecorderTreeProvider?.refresh();
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('hex');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="
    default-src 'none';
    style-src ${webview.cspSource} 'unsafe-inline';
    script-src 'nonce-${nonce}';
    img-src ${webview.cspSource} https: data:;
    font-src ${webview.cspSource};
  ">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>FORGE//SENTINEL</title>
  <style>
    :root {
      --bg: #0d1117;
      --card-bg: #161b22;
      --card-border: #30363d;
      --text: #c9d1d9;
      --text-muted: #8b949e;
      --text-bright: #f0f6fc;
      --cobalt: #38bdf8;
      --cobalt-dark: #0284c7;
      --lime: #34d399;
      --amber: #fbbf24;
      --crimson: #f87171;
      --violet: #a78bfa;
      --subtle-bg: #21262d;
    }
    body {
      background-color: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      margin: 0;
      padding: 10px;
      font-size: 12px;
      line-height: 1.45;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--card-border);
      margin-bottom: 10px;
    }
    .brand {
      font-weight: 700;
      font-size: 13px;
      letter-spacing: 0.04em;
      color: var(--text-bright);
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .status-pills {
      display: flex;
      gap: 6px;
      align-items: center;
    }
    .pill {
      font-size: 10px;
      padding: 2px 7px;
      border-radius: 10px;
      border: 1px solid var(--card-border);
      background: var(--card-bg);
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .pill.online {
      color: var(--lime);
      border-color: rgba(52, 211, 153, 0.4);
    }
    .pill.offline {
      color: var(--crimson);
      border-color: rgba(248, 113, 113, 0.4);
    }
    .pill.model {
      color: var(--cobalt);
      border-color: rgba(56, 189, 248, 0.4);
    }

    /* Execution Step Pipeline */
    .step-pipeline {
      display: flex;
      gap: 4px;
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      padding: 6px;
      border-radius: 6px;
      margin-bottom: 10px;
      overflow-x: auto;
    }
    .step-node {
      font-size: 10px;
      padding: 3px 6px;
      border-radius: 4px;
      background: var(--subtle-bg);
      color: var(--text-muted);
      white-space: nowrap;
      transition: all 0.2s ease;
    }
    .step-node.active {
      background: var(--cobalt-dark);
      color: #ffffff;
      font-weight: 600;
      box-shadow: 0 0 6px rgba(56, 189, 248, 0.5);
    }
    .step-node.completed {
      background: rgba(52, 211, 153, 0.2);
      color: var(--lime);
    }

    /* Chat / Message Stream */
    .chat-container {
      display: flex;
      flex-direction: column;
      gap: 8px;
      max-height: 280px;
      overflow-y: auto;
      margin-bottom: 10px;
      padding-right: 4px;
    }
    .message {
      padding: 8px 10px;
      border-radius: 6px;
      font-size: 12px;
      border: 1px solid var(--card-border);
    }
    .message.user {
      background: #172554;
      border-color: #1e3a8a;
      color: #e0f2fe;
    }
    .message.assistant {
      background: var(--card-bg);
      border-color: var(--card-border);
    }
    .tool-box {
      background: #020617;
      border: 1px solid #1e293b;
      padding: 6px 8px;
      border-radius: 4px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 11px;
      color: #7dd3fc;
    }
    .receipt-box {
      background: #1e1b4b;
      border: 1px solid #312e81;
      padding: 8px 10px;
      border-radius: 6px;
      font-size: 11px;
    }
    .receipt-title {
      font-weight: 600;
      color: var(--amber);
      display: flex;
      justify-content: space-between;
      margin-bottom: 4px;
    }
    .token-meter {
      height: 4px;
      background: #374151;
      border-radius: 2px;
      margin: 4px 0 6px 0;
      overflow: hidden;
    }
    .token-meter-fill {
      height: 100%;
      background: var(--amber);
      width: 0%;
      transition: width 0.3s ease;
    }

    /* Staged Patches */
    .staged-patch {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 6px;
      padding: 10px;
      margin-bottom: 8px;
    }
    .patch-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 4px;
    }
    .file-chip {
      font-weight: 600;
      color: var(--text-bright);
      font-family: ui-monospace, SFMono-Regular, monospace;
      font-size: 11px;
    }
    .badge {
      font-size: 9px;
      padding: 2px 6px;
      border-radius: 4px;
      text-transform: uppercase;
      font-weight: 600;
    }
    .badge.staged { background: #854d0e; color: #fef08a; }
    .badge.applied { background: #065f46; color: #a7f3d0; }
    .badge.rejected { background: #991b1b; color: #fecaca; }
    .badge.risk-low { background: #14532d; color: #86efac; }
    .badge.risk-medium { background: #713f12; color: #fde047; }
    .badge.risk-high { background: #7f1d1d; color: #fca5a5; }

    .patch-purpose {
      font-size: 11px;
      color: var(--text-muted);
      margin-bottom: 8px;
    }
    .hunk-list {
      margin: 6px 0 8px 0;
      padding: 4px;
      background: #090d13;
      border-radius: 4px;
      font-family: ui-monospace, SFMono-Regular, monospace;
      font-size: 10px;
    }
    .hunk-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 2px 4px;
    }

    /* Proof of Change Report */
    .proof-card {
      background: #022c22;
      border: 1px solid #059669;
      padding: 10px;
      border-radius: 6px;
      margin: 10px 0;
      font-size: 11px;
    }
    .proof-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-weight: 700;
      color: #6ee7b7;
      margin-bottom: 6px;
    }
    .test-result-row {
      display: flex;
      justify-content: space-between;
      padding: 2px 0;
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
    }

    /* Quick Prompts / Empty State */
    .quick-prompts {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin-top: 8px;
    }
    .quick-chip {
      background: var(--subtle-bg);
      border: 1px solid var(--card-border);
      border-radius: 4px;
      padding: 6px 8px;
      color: var(--cobalt);
      font-size: 11px;
      cursor: pointer;
      text-align: left;
    }
    .quick-chip:hover {
      background: #28303a;
      border-color: var(--cobalt);
    }

    /* Buttons */
    .btn-group {
      display: flex;
      gap: 6px;
    }
    button {
      background: var(--cobalt-dark);
      color: #ffffff;
      border: none;
      padding: 5px 10px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 11px;
      font-weight: 600;
      transition: background 0.15s ease;
    }
    button:hover { background: #0369a1; }
    button.secondary { background: #374151; }
    button.secondary:hover { background: #4b5563; }
    button.danger { background: #991b1b; }
    button.danger:hover { background: #b91c1c; }
    button.success { background: #065f46; }
    button.success:hover { background: #047857; }
    button.tiny { padding: 2px 6px; font-size: 9px; }

    /* Input */
    .input-area {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-top: 8px;
    }
    textarea {
      width: 100%;
      box-sizing: border-box;
      background: var(--card-bg);
      color: var(--text-bright);
      border: 1px solid var(--card-border);
      border-radius: 6px;
      padding: 8px;
      font-size: 12px;
      resize: vertical;
      min-height: 55px;
      font-family: inherit;
    }
    textarea:focus {
      outline: none;
      border-color: var(--cobalt);
    }
    .actions {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="brand">
      <span>🛡️</span> FORGE//SENTINEL
    </div>
    <div class="status-pills">
      <div id="statusBadge" class="pill offline">Daemon: Offline</div>
      <div id="modelPill" class="pill model">Model: Ready</div>
    </div>
  </div>

  <!-- Live Execution Step Pipeline -->
  <div class="step-pipeline" id="stepPipeline">
    <div class="step-node active" id="step-idle">1. Idle</div>
    <div class="step-node" id="step-understanding">2. Understand</div>
    <div class="step-node" id="step-retrieving">3. Auction</div>
    <div class="step-node" id="step-searching">4. MRI</div>
    <div class="step-node" id="step-planning">5. Plan</div>
    <div class="step-node" id="step-staging">6. Stage</div>
    <div class="step-node" id="step-testing">7. Test</div>
    <div class="step-node" id="step-completed" style="display: none;">8. Completed</div>
    <div class="step-node" id="step-proven">8. Proven</div>
    <div class="step-node" id="step-failed" style="display: none;">Failed</div>
    <div class="step-node" id="step-cancelled" style="display: none;">Cancelled</div>
  </div>

  <div id="chat" class="chat-container">
    <div class="message assistant">
      <strong>Sentinel Command Center:</strong> Ready. Codebase MRI, Context Auction, Surgical Patch Staging, and Proof-Carrying Code active.
      <div class="quick-prompts">
        <div class="quick-chip" data-prompt="Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking keys containing SECRET, PASSWORD, TOKEN, or KEY as '***'.">
          ⚡ <strong>Task B:</strong> Add built-in "flask config" command with recursive masking
        </div>
        <div class="quick-chip" data-prompt="In src/flask/helpers.py, treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value treated as false.">
          ⚡ <strong>Task A:</strong> Inline edit on get_debug_flag ('off' and 'n')
        </div>
      </div>
    </div>
  </div>

  <div id="stagedContainer"></div>
  <div id="proofContainer"></div>

  <div class="input-area">
    <textarea id="promptInput" placeholder="Enter instructions (e.g. 'Add built-in flask config command...'). Use @file and @symbol for surgical precision."></textarea>
    <div class="actions">
      <div class="btn-group">
        <button id="scanBtn" class="secondary" title="Run Codebase MRI structural scan">Scan MRI</button>
        <button id="cancelBtn" class="danger" style="display: none;">Cancel Turn</button>
      </div>
      <button id="sendBtn">Execute Turn</button>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const chat = document.getElementById('chat');
    const promptInput = document.getElementById('promptInput');
    const sendBtn = document.getElementById('sendBtn');
    const cancelBtn = document.getElementById('cancelBtn');
    const scanBtn = document.getElementById('scanBtn');
    const statusBadge = document.getElementById('statusBadge');
    const modelPill = document.getElementById('modelPill');
    const stagedContainer = document.getElementById('stagedContainer');
    const proofContainer = document.getElementById('proofContainer');
    const stepPipeline = document.getElementById('stepPipeline');

    let currentStreamingElem = null;

    sendBtn.addEventListener('click', () => {
      const text = promptInput.value.trim();
      if (!text) return;
      promptInput.value = '';
      vscode.postMessage({ command: 'submitPrompt', text });
    });

    cancelBtn.addEventListener('click', () => {
      vscode.postMessage({ command: 'cancelTurn' });
    });

    scanBtn.addEventListener('click', () => {
      vscode.postMessage({ command: 'scanWorkspace' });
    });

    document.querySelectorAll('.quick-chip').forEach(el => {
      el.addEventListener('click', () => {
        const p = el.getAttribute('data-prompt');
        if (p) {
          promptInput.value = p;
          sendBtn.click();
        }
      });
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      switch (msg.type) {
        case 'statusUpdate':
          if (msg.connected) {
            statusBadge.className = 'pill online';
            statusBadge.textContent = 'TrueForge: Online';
            if (msg.activeModel) {
              modelPill.textContent = msg.activeModel;
            }
          } else {
            statusBadge.className = 'pill offline';
            statusBadge.textContent = 'TrueForge: Offline';
          }
          break;

        case 'executionStep':
          updateStepPipeline(msg.step);
          break;

        case 'turnStarted':
          sendBtn.disabled = true;
          cancelBtn.style.display = 'inline-block';
          currentStreamingElem = document.createElement('div');
          currentStreamingElem.className = 'message assistant';
          currentStreamingElem.innerHTML = '<strong>Sentinel Agent:</strong> <span class="stream-body"></span>';
          chat.appendChild(currentStreamingElem);
          chat.scrollTop = chat.scrollHeight;
          break;

        case 'turnEnded':
          sendBtn.disabled = false;
          cancelBtn.style.display = 'none';
          currentStreamingElem = null;
          break;

        case 'tokenDelta':
          if (currentStreamingElem) {
            const body = currentStreamingElem.querySelector('.stream-body');
            if (body) {
              body.textContent += msg.delta;
              chat.scrollTop = chat.scrollHeight;
            }
          }
          break;

        case 'userMessage':
          const userElem = document.createElement('div');
          userElem.className = 'message user';
          userElem.innerHTML = '<strong>Developer:</strong> ' + escapeHtml(msg.text);
          chat.appendChild(userElem);
          chat.scrollTop = chat.scrollHeight;
          break;

        case 'toolCall':
          const toolBox = document.createElement('div');
          toolBox.className = 'tool-box';
          toolBox.textContent = '⚙️ [Tool Call] ' + msg.call.name + '(' + JSON.stringify(msg.call.args) + ')';
          chat.appendChild(toolBox);
          chat.scrollTop = chat.scrollHeight;
          break;

        case 'contextReceipt':
          renderContextReceipt(msg.receipt);
          break;

        case 'stagedPatches':
          renderStagedPatches(msg.patches);
          break;

        case 'proofOfChange':
          renderProofOfChange(msg.report);
          break;

        case 'log':
          const logElem = document.createElement('div');
          logElem.style.fontSize = '11px';
          logElem.style.color = 'var(--text-muted)';
          logElem.textContent = '• ' + msg.message;
          chat.appendChild(logElem);
          chat.scrollTop = chat.scrollHeight;
          break;

        case 'error':
          const errElem = document.createElement('div');
          errElem.className = 'message';
          errElem.style.background = '#450a0a';
          errElem.style.borderColor = '#b91c1c';
          errElem.style.color = '#fecaca';
          errElem.innerHTML = '<strong>Error Trapped by Sentinel:</strong> ' + escapeHtml(msg.message);
          chat.appendChild(errElem);
          chat.scrollTop = chat.scrollHeight;
          break;
      }
    });

    function updateStepPipeline(step) {
      document.querySelectorAll('.step-node').forEach(n => {
        n.classList.remove('active');
      });

      // Special handling for completed / proven / failed / cancelled
      if (step === 'completed') {
        const compNode = document.getElementById('step-completed');
        if (compNode) {
          compNode.style.display = 'inline-block';
          compNode.classList.add('active');
        }
      } else if (step === 'failed') {
        const failNode = document.getElementById('step-failed');
        if (failNode) {
          failNode.style.display = 'inline-block';
          failNode.classList.add('active');
        }
      } else if (step === 'cancelled') {
        const cancNode = document.getElementById('step-cancelled');
        if (cancNode) {
          cancNode.style.display = 'inline-block';
          cancNode.classList.add('active');
        }
      } else {
        const target = document.getElementById('step-' + step);
        if (target) {
          target.classList.add('active');
        }
      }
    }

    function renderContextReceipt(r) {
      const receiptBox = document.createElement('div');
      receiptBox.className = 'receipt-box';
      const totalBudget = r.tokenBudget || 16000;
      const codeBudget = r.codeBudget || Math.round(totalBudget * 0.7);
      const retrievedCodeTok = r.retrievedCodeTokens ?? r.totalTokensUsed ?? 0;
      const estimatedReqTok = r.estimatedRequestTokens ?? retrievedCodeTok;
      const reservedOutTok = r.reservedOutputTokens ?? (r.reservedCapacity ? r.reservedCapacity.output : 0);
      const safetyMarginTok = r.safetyMarginTokens ?? (r.reservedCapacity ? (r.reservedCapacity.safetyMargin || 0) : 0);
      const totalCapacityTok = r.totalContextCapacity ?? totalBudget;
      const codePct = Math.min(100, Math.round((retrievedCodeTok / codeBudget) * 100));

      let selectedList = r.selectedFiles.map(f => 
        '<li style="margin-bottom:2px;"><code>' + f.filePath + '</code> (' + f.estimatedTokens + ' tok, score: ' + f.score + ') - <em>' + escapeHtml(f.relevanceRationale) + '</em></li>'
      ).join('');

      let excludedList = r.excludedFiles.map(e =>
        '<li><code>' + e.filePath + '</code>: ' + escapeHtml(e.exclusionReason) + '</li>'
      ).join('');

      const breakdownHtml =
        '<div style="display:grid; grid-template-columns:1fr 1fr; gap:3px 8px; font-size:10px; color:#cbd5e1; margin:4px 0 6px 0; padding:4px 6px; background:rgba(0,0,0,0.25); border-radius:4px;">' +
          '<span><strong>1. Retrieved Code:</strong> ' + retrievedCodeTok + ' tok</span>' +
          '<span><strong>2. Est. Complete Req:</strong> ' + estimatedReqTok + ' tok</span>' +
          '<span><strong>3. Reserved Output:</strong> ' + reservedOutTok + ' tok</span>' +
          '<span><strong>4. Safety Margin:</strong> ' + safetyMarginTok + ' tok</span>' +
          '<span style="grid-column:span 2;"><strong>5. Total Context Capacity:</strong> ' + totalCapacityTok.toLocaleString() + ' tok (Auction Ceiling: ' + totalBudget.toLocaleString() + ' tok)</span>' +
        '</div>';

      receiptBox.innerHTML = 
        '<div class="receipt-title">' +
          '<span>📋 Context Selection Receipt</span>' +
          '<span>' + retrievedCodeTok + ' / ' + codeBudget + ' code tok (' + codePct + '%)</span>' +
        '</div>' +
        '<div class="token-meter"><div class="token-meter-fill" style="width:' + codePct + '%;"></div></div>' +
        breakdownHtml +
        '<details style="cursor:pointer;"><summary><strong>' + r.selectedFiles.length + ' High-Relevance Selected Files</strong></summary>' +
          '<ul style="margin:4px 0; padding-left:16px;">' + selectedList + '</ul>' +
        '</details>' +
        (r.excludedFiles.length > 0 ? 
          '<details style="cursor:pointer; margin-top:4px;"><summary style="color:var(--text-muted);">' + r.excludedFiles.length + ' Excluded Candidates</summary>' +
            '<ul style="margin:4px 0; padding-left:16px; color:var(--text-muted);">' + excludedList + '</ul>' +
          '</details>' : '');

      chat.appendChild(receiptBox);
      chat.scrollTop = chat.scrollHeight;
    }

    function renderStagedPatches(patches) {
      stagedContainer.innerHTML = '';
      if (!patches || patches.length === 0) return;

      const title = document.createElement('div');
      title.style.fontWeight = '600';
      title.style.margin = '10px 0 6px 0';
      title.style.color = 'var(--text-bright)';
      title.textContent = 'Proposed Surgical Patches (' + patches.length + ')';
      stagedContainer.appendChild(title);

      for (const p of patches) {
        const item = document.createElement('div');
        item.className = 'staged-patch';

        const riskClass = 'badge risk-' + (p.riskLevel || 'low');
        const statusClass = 'badge ' + p.status;

        let hunkMarkup = '';
        if (p.hunks && p.hunks.length > 0) {
          hunkMarkup = '<div class="hunk-list">';
          p.hunks.forEach((h, idx) => {
            const checked = h.accepted !== false ? 'checked' : '';
            hunkMarkup += '<div class="hunk-row">' +
              '<span>' + h.header + '</span>' +
              '<label style="cursor:pointer;"><input type="checkbox" class="hunk-toggle" data-patch="' + p.patchId + '" data-hunk="' + h.hunkId + '" ' + checked + '> Include</label>' +
            '</div>';
          });
          hunkMarkup += '</div>';
        }

        item.innerHTML = 
          '<div class="patch-header">' +
            '<span class="file-chip">' + p.filePath + '</span>' +
            '<div style="display:flex; gap:4px;">' +
              '<span class="' + riskClass + '">' + (p.riskLevel || 'low') + ' risk</span>' +
              '<span class="' + statusClass + '">' + p.status + '</span>' +
            '</div>' +
          '</div>' +
          '<div class="patch-purpose">' + escapeHtml(p.purpose) + '</div>' +
          hunkMarkup +
          '<div class="btn-group">' +
            '<button class="secondary review-btn" data-id="' + p.patchId + '">Review Diff</button>' +
            (p.status === 'applied' ? 
              '<button class="danger revert-btn" data-id="' + p.patchId + '">Revert Patch</button>' :
              '<button class="success accept-btn" data-id="' + p.patchId + '">Apply Patch</button><button class="danger reject-btn" data-id="' + p.patchId + '">Reject</button>'
            ) +
          '</div>';

        item.querySelector('.review-btn').addEventListener('click', () => {
          vscode.postMessage({ command: 'reviewPatchDiff', patchId: p.patchId });
        });

        const acceptBtn = item.querySelector('.accept-btn');
        if (acceptBtn) {
          acceptBtn.addEventListener('click', () => {
            vscode.postMessage({ command: 'acceptPatch', patchId: p.patchId });
          });
        }

        const rejectBtn = item.querySelector('.reject-btn');
        if (rejectBtn) {
          rejectBtn.addEventListener('click', () => {
            vscode.postMessage({ command: 'rejectPatch', patchId: p.patchId });
          });
        }

        const revertBtn = item.querySelector('.revert-btn');
        if (revertBtn) {
          revertBtn.addEventListener('click', () => {
            vscode.postMessage({ command: 'revertPatch', patchId: p.patchId });
          });
        }

        item.querySelectorAll('.hunk-toggle').forEach(chk => {
          chk.addEventListener('change', (e) => {
            vscode.postMessage({
              command: 'toggleHunk',
              patchId: e.target.getAttribute('data-patch'),
              hunkId: e.target.getAttribute('data-hunk'),
              accepted: e.target.checked
            });
          });
        });

        stagedContainer.appendChild(item);
      }
    }

    function renderProofOfChange(report) {
      proofContainer.innerHTML = '';
      const box = document.createElement('div');
      box.className = 'proof-card';

      let badgeStyle = 'background:#064e3b; color:#a7f3d0; border:1px solid #10b981;';
      if (report.status === 'read_only_completed') {
        badgeStyle = 'background:#0c4a6e; color:#bae6fd; border:1px solid #0284c7;';
      } else if (report.status === 'failed') {
        badgeStyle = 'background:#450a0a; color:#fecaca; border:1px solid #ef4444;';
      } else if (report.status === 'partial') {
        badgeStyle = 'background:#451a03; color:#fde68a; border:1px solid #d97706;';
      } else if (report.status === 'unverified') {
        badgeStyle = 'background:#1f2937; color:#9ca3af; border:1px solid #4b5563;';
      }

      let testRows = '';
      if (report.status === 'read_only_completed') {
        testRows = '<div style="color:#7dd3fc;">✓ Read-only architecture inquiry (test suite execution not required).</div>';
      } else if (report.testResults && report.testResults.length > 0) {
        testRows = report.testResults.map(r => {
          const color = r.status === 'passed' ? '#34d399' : (r.status === 'failed' ? '#f87171' : '#fbbf24');
          return '<div class="test-result-row"><span>' + escapeHtml(r.testName) + '</span><strong style="color:' + color + ';">' + r.status.toUpperCase() + '</strong></div>';
        }).join('');
      } else {
        testRows = '<div style="color:#9ca3af;">No test executions recorded.</div>';
      }

      const displayStatus = report.status === 'read_only_completed' ? 'READ-ONLY COMPLETED' : report.status.toUpperCase();

      box.innerHTML = 
        '<div class="proof-header">' +
          '<span>🛡️ Proof-Carrying Code Report</span>' +
          '<span class="badge" style="' + badgeStyle + '">' + displayStatus + '</span>' +
        '</div>' +
        '<div style="margin-bottom:6px;"><strong>Modified Files (' + report.filesModified.length + '):</strong> ' + (report.filesModified.join(', ') || 'None') + '</div>' +
        '<div style="margin-bottom:6px;"><strong>Patches:</strong> ' + report.patchesAccepted + ' accepted / ' + report.patchesProposed + ' proposed</div>' +
        '<div style="font-weight:600; margin-top:8px; margin-bottom:4px;">Verification Results:</div>' +
        '<div style="background:rgba(0,0,0,0.2); padding:6px; border-radius:4px;">' + testRows + '</div>' +
        (report.remainingRisks && report.remainingRisks.length > 0 ? 
          '<div style="margin-top:6px; color:#fde68a;">⚠️ <strong>Advisory:</strong> ' + escapeHtml(report.remainingRisks.join('; ')) + '</div>' : '');

      proofContainer.appendChild(box);
    }

    function escapeHtml(str) {
      if (!str) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }
  </script>
</body>
</html>`;
  }
}
