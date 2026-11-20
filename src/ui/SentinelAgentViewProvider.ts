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
import type { ConnectionLifecycleManager, DetailedConnectionStatus } from '../agent/ConnectionLifecycleManager.js';
import type { SentinelMcpServer } from '../mcp/SentinelMcpServer.js';

export class SentinelAgentViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'forge-sentinel.agentPanel';
  private _view?: vscode.WebviewView;
  private currentAbortController?: AbortController;
  private activeSessionId?: string;
  private readonly modelRescue = new ModelRescue(2);
  private conversationHistoryTokens = 0;
  private recordedToolResults: Array<{ id: string; toolName?: string; result: unknown }> = [];
  private userSelectedModel?: string;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly workspaceRoot: string,
    private readonly patchManager: PatchStagingManager,
    private readonly mri: CodebaseMri,
    private readonly auction: ContextAuction,
    private readonly trueforge: TrueForgeHarnessClient,
    private readonly flightRecorder: FlightRecorder,
    private readonly stagedPatchesTreeProvider?: StagedPatchesTreeDataProvider,
    private readonly flightRecorderTreeProvider?: FlightRecorderTreeDataProvider,
    private readonly mcpServer?: SentinelMcpServer,
    private connectionManager?: ConnectionLifecycleManager
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
        case 'selectModel': {
          this.userSelectedModel = message.modelName;
          this.activeSessionId = undefined;
          if (this.connectionManager) {
            this.connectionManager.setPreferredModel(this.userSelectedModel);
          }
          await this.updateConnectionStatus();
          break;
        }
        case 'openApiKeyConfig': {
          await this.handleOpenApiKeyConfig();
          break;
        }
      }
    });

    if (this.connectionManager) {
      (this.connectionManager as any).onStatusChange = (status: DetailedConnectionStatus) => {
        this.postStatusUpdate(status);
      };
    }

    this.updateConnectionStatus();
  }

  public setConnectionManager(manager: ConnectionLifecycleManager): void {
    this.connectionManager = manager;
    (this.connectionManager as any).onStatusChange = (status: DetailedConnectionStatus) => {
      this.postStatusUpdate(status);
    };
  }

  public async updateConnectionStatus(): Promise<DetailedConnectionStatus> {
    if (this.connectionManager) {
      const status = await this.connectionManager.triggerImmediateCheck();
      this.postStatusUpdate(status);
      return status;
    }

    try {
      const health = await this.trueforge.checkHealth();
      const authoritative = await this.trueforge.resolveAuthoritativeModel(this.userSelectedModel);
      const models = await this.trueforge.getAvailableModels();
      let mcpOnline = false;
      if (this.mcpServer) {
        mcpOnline = await this.trueforge.checkMcpServerHealth(this.mcpServer.getHealthUrl());
      }
      const isFullyOnline = health.status === 'ok' && (!this.mcpServer || mcpOnline);

      const status: DetailedConnectionStatus = {
        state: isFullyOnline ? 'connected' : 'degraded_mcp',
        connected: isFullyOnline,
        daemonOnline: health.status === 'ok',
        daemonVersion: health.version ?? '0.0.0',
        mcpOnline,
        mcpSynchronized: isFullyOnline,
        activeModel: authoritative.displayName,
        modelName: authoritative.name,
        models: models.map((m) => ({
          name: m.name,
          displayName: m.displayName,
          isAvailable: m.isAvailable,
        })),
        error: isFullyOnline ? undefined : 'Sentinel MCP server offline or not synchronized',
      };
      this.postStatusUpdate(status);
      return status;
    } catch {
      const status: DetailedConnectionStatus = {
        state: 'disconnected',
        connected: false,
        daemonOnline: false,
        mcpOnline: false,
        mcpSynchronized: false,
        error: 'TrueForge daemon unreachable on port 8790',
      };
      this.postStatusUpdate(status);
      return status;
    }
  }

  private postStatusUpdate(status: DetailedConnectionStatus): void {
    this._view?.webview.postMessage({
      type: 'statusUpdate',
      ...status,
    });
  }

  private async handleOpenApiKeyConfig(): Promise<void> {
    const choice = await vscode.window.showQuickPick(
      [
        { label: 'Google Gemini', description: 'Configure GEMINI_API_KEY (Primary native provider)' },
        { label: 'OpenRouter', description: 'Configure OPENROUTER_API_KEY (Multi-model fallback provider)' },
      ],
      { placeHolder: 'Select AI model provider to configure' }
    );
    if (!choice) return;

    const apiKey = await vscode.window.showInputBox({
      password: true,
      prompt: `Enter API key for ${choice.label}`,
      placeHolder: 'Paste secret key here (input is masked and securely stored)',
    });
    if (!apiKey || apiKey.trim() === '') return;

    this._view?.webview.postMessage({ type: 'log', message: `Configuring ${choice.label} in TrueForge...` });
    let success = false;
    if (choice.label === 'Google Gemini') {
      success = await this.trueforge.ensureGeminiProviderConfigured(apiKey.trim(), this.workspaceRoot);
    } else {
      success = await this.trueforge.ensureOpenRouterProviderConfigured(apiKey.trim(), this.workspaceRoot);
    }

    if (success) {
      vscode.window.showInformationMessage(`Successfully configured ${choice.label} in TrueForge.`);
      await this.updateConnectionStatus();
    } else {
      vscode.window.showErrorMessage(`Failed to configure ${choice.label} in TrueForge. Please verify daemon is running.`);
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

    // Pre-flight check: Ensure both TrueForge daemon and Sentinel MCP server are online and synchronized
    const connStatus = await this.updateConnectionStatus();
    if (!connStatus.connected) {
      this.postExecutionStep('failed');
      const err = connStatus.error || 'TrueForge daemon or Sentinel MCP server is unreachable.';
      this._view?.webview.postMessage({ type: 'userMessage', text: promptText });
      this._view?.webview.postMessage({
        type: 'agentMessage',
        text: `⚠️ **[Connection Error]** ${err}\n\nPlease ensure both the TrueForge daemon (\`http://localhost:8790\`) and Sentinel MCP server (\`port ${this.mcpServer?.getPort() ?? 9099}\`) are online.`,
      });
      return;
    }

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
      await this.trueforge.ensureOpenRouterProviderConfigured(undefined, this.workspaceRoot);
      const authoritative = await this.trueforge.resolveAuthoritativeModel(this.userSelectedModel);
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
    /* ==========================================================================
       BAUHAUS × BOLD NEO-BRUTALISM × TECHNICAL EDITORIAL DESIGN SYSTEM
       "Paper Protocol" Design Tokens
       ========================================================================== */
    :root {
      /* Primary Surfaces */
      --paper-warm: #F2EBDD;
      --paper-white: #FFFFFF;
      --paper-secondary: #EAE5D9;
      --paper-neutral: #E5E2DA;
      
      /* Ink & Boundaries */
      --ink-black: #171717;
      --ink-muted: #66615A;
      --border-bold: #242424;
      --border-subtle: #D2CBBE;
      
      /* Bauhaus & Signal Brand Accents */
      --signal-red: #D7263D;
      --bauhaus-yellow: #F4B400;
      --electric-cobalt: #1E4CA1;
      --cobalt-hover: #153878;
      --verified-green: #18794E;
      
      /* Subtle Tints for High Contrast */
      --tint-green: #E8F5E9;
      --tint-yellow: #FEF9C3;
      --tint-red: #FEE2E2;
      --tint-cobalt: #EFF6FF;

      /* Neo-Brutalist Hard Shadows */
      --shadow-sm: 2px 2px 0px var(--ink-black);
      --shadow-md: 3px 3px 0px var(--ink-black);
      --shadow-focus: 2px 2px 0px var(--electric-cobalt);
    }

    /* Base Reset & Typography */
    *, *::before, *::after {
      box-sizing: border-box;
    }
    body {
      background-color: var(--paper-warm);
      color: var(--ink-black);
      font-family: -apple-system, BlinkMacSystemFont, "Space Grotesk", "Inter", "Segoe UI", Roboto, sans-serif;
      margin: 0;
      padding: 10px;
      font-size: 12px;
      line-height: 1.45;
      overflow-x: hidden;
    }

    /* Technical Monospace Elements */
    code, pre, .mono, .tool-box, .hunk-list, .file-chip, select, textarea {
      font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }

    /* ==========================================================================
       COMMAND CENTER HEADER (Bauhaus Geometric Lockup)
       ========================================================================== */
    .header {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding-bottom: 8px;
      border-bottom: 2px solid var(--border-bold);
      margin-bottom: 8px;
    }
    .header-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .brand {
      font-weight: 800;
      font-size: 13px;
      letter-spacing: 0.05em;
      color: var(--ink-black);
      display: flex;
      align-items: center;
      gap: 7px;
      text-transform: uppercase;
    }
    .brand-mark {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      background: var(--paper-white);
      border: 2px solid var(--border-bold);
      border-radius: 4px;
      box-shadow: var(--shadow-sm);
    }
    .status-pills {
      display: flex;
      gap: 5px;
      align-items: center;
      flex-wrap: wrap;
    }
    .pill {
      font-size: 9.5px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.03em;
      padding: 2px 7px;
      border-radius: 3px;
      border: 1.5px solid var(--border-bold);
      background: var(--paper-white);
      color: var(--ink-black);
      display: inline-flex;
      align-items: center;
      gap: 4px;
      box-shadow: 1px 1px 0px var(--border-bold);
    }
    .pill.online {
      color: var(--verified-green);
      background: var(--tint-green);
      border-color: var(--verified-green);
    }
    .pill.offline {
      color: var(--signal-red);
      background: var(--tint-red);
      border-color: var(--signal-red);
    }
    .pill.degraded {
      color: #92400e;
      background: var(--tint-yellow);
      border-color: var(--bauhaus-yellow);
    }
    .pill.model {
      color: var(--electric-cobalt);
      background: var(--tint-cobalt);
      border-color: var(--electric-cobalt);
    }

    /* Subtitle Tagline */
    .brand-tagline {
      font-size: 9px;
      font-weight: 600;
      color: var(--ink-muted);
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    /* ==========================================================================
       MODEL & PROVIDER CONTROL BAR
       ========================================================================== */
    .model-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin: 0 0 8px 0;
      gap: 6px;
      padding: 6px 8px;
      background: var(--paper-white);
      border-radius: 4px;
      border: 2px solid var(--border-bold);
      box-shadow: var(--shadow-sm);
      flex-wrap: wrap;
    }
    .model-label {
      font-size: 9.5px;
      color: var(--ink-black);
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      white-space: nowrap;
    }
    select#modelSelect {
      flex: 1;
      min-width: 140px;
      font-size: 11px;
      font-weight: 600;
      background: var(--paper-warm);
      color: var(--ink-black);
      border: 1.5px solid var(--border-bold);
      border-radius: 3px;
      padding: 3px 6px;
      outline: none;
      cursor: pointer;
    }
    select#modelSelect:focus {
      border-color: var(--electric-cobalt);
      box-shadow: 0 0 0 1px var(--electric-cobalt);
    }

    /* ==========================================================================
       EIGHT-STAGE EXECUTION PIPELINE
       ========================================================================== */
    .step-pipeline {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      background: var(--paper-white);
      border: 2px solid var(--border-bold);
      padding: 6px;
      border-radius: 4px;
      margin-bottom: 8px;
      box-shadow: var(--shadow-sm);
    }
    .step-node {
      flex: 1 1 calc(25% - 4px);
      min-width: 65px;
      font-size: 9px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.02em;
      padding: 3px 5px;
      border-radius: 3px;
      background: var(--paper-warm);
      color: var(--ink-muted);
      border: 1.5px solid var(--border-subtle);
      text-align: center;
      white-space: nowrap;
      transition: all 0.15s ease;
    }
    .step-node.active {
      background: var(--bauhaus-yellow);
      color: var(--ink-black);
      border-color: var(--ink-black);
      font-weight: 800;
      box-shadow: 1.5px 1.5px 0px var(--ink-black);
    }
    .step-node.completed {
      background: var(--verified-green);
      color: #ffffff;
      border-color: var(--border-bold);
    }
    .step-node.failed {
      background: var(--signal-red);
      color: #ffffff;
      border-color: var(--border-bold);
    }

    /* ==========================================================================
       CONVERSATION / CHAT STREAM CONTAINER
       ========================================================================== */
    .chat-container {
      display: flex;
      flex-direction: column;
      gap: 8px;
      max-height: 290px;
      overflow-y: auto;
      margin-bottom: 8px;
      padding-right: 2px;
    }
    .message {
      padding: 9px 11px;
      border-radius: 4px;
      font-size: 11.5px;
      border: 2px solid var(--border-bold);
      box-shadow: var(--shadow-sm);
      word-wrap: break-word;
    }
    .message.user {
      background: var(--tint-cobalt);
      border-color: var(--electric-cobalt);
      color: var(--ink-black);
    }
    .message.assistant {
      background: var(--paper-white);
      border-color: var(--border-bold);
      color: var(--ink-black);
    }
    .message-tag {
      font-size: 9.5px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      display: inline-block;
      margin-bottom: 4px;
    }
    .message.user .message-tag { color: var(--electric-cobalt); }
    .message.assistant .message-tag { color: var(--ink-black); }

    /* Tool Call Cards */
    .tool-box {
      background: var(--paper-secondary);
      border: 2px solid var(--border-bold);
      box-shadow: var(--shadow-sm);
      padding: 7px 9px;
      border-radius: 4px;
      font-size: 10.5px;
      color: var(--ink-black);
      margin-top: 2px;
      word-break: break-all;
    }
    .tool-box strong {
      color: var(--electric-cobalt);
    }

    /* Context Auction Receipt Box */
    .receipt-box {
      background: var(--paper-white);
      border: 2px solid var(--border-bold);
      box-shadow: var(--shadow-md);
      padding: 9px 11px;
      border-radius: 4px;
      font-size: 11px;
      margin: 4px 0;
    }
    .receipt-title {
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--ink-black);
      display: flex;
      justify-content: space-between;
      margin-bottom: 4px;
      font-size: 10px;
    }
    .token-meter {
      height: 6px;
      background: var(--paper-neutral);
      border: 1.5px solid var(--border-bold);
      border-radius: 2px;
      margin: 4px 0 6px 0;
      overflow: hidden;
    }
    .token-meter-fill {
      height: 100%;
      background: var(--bauhaus-yellow);
      width: 0%;
      transition: width 0.3s ease;
    }
    .breakdown-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 3px 8px;
      font-size: 10px;
      color: var(--ink-black);
      margin: 6px 0;
      padding: 6px 8px;
      background: var(--paper-warm);
      border: 1.5px solid var(--border-bold);
      border-radius: 3px;
    }

    /* ==========================================================================
       SURGICAL STAGED PATCHES
       ========================================================================== */
    .staged-patch {
      background: var(--paper-white);
      border: 2px solid var(--border-bold);
      box-shadow: var(--shadow-md);
      border-radius: 4px;
      padding: 10px;
      margin-bottom: 8px;
    }
    .patch-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 6px;
      gap: 6px;
      flex-wrap: wrap;
    }
    .file-chip {
      font-weight: 700;
      color: var(--electric-cobalt);
      font-size: 11px;
      word-break: break-all;
    }
    .badge {
      font-size: 9px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      padding: 2px 6px;
      border-radius: 3px;
      border: 1.5px solid var(--border-bold);
      white-space: nowrap;
    }
    .badge.staged { background: var(--tint-yellow); color: #854d0e; }
    .badge.applied { background: var(--tint-green); color: var(--verified-green); }
    .badge.rejected { background: var(--tint-red); color: var(--signal-red); }
    .badge.risk-low { background: var(--tint-green); color: var(--verified-green); }
    .badge.risk-medium { background: var(--tint-yellow); color: #854d0e; }
    .badge.risk-high { background: var(--tint-red); color: var(--signal-red); }

    .patch-purpose {
      font-size: 11px;
      color: var(--ink-muted);
      margin-bottom: 8px;
      line-height: 1.4;
    }
    .hunk-list {
      margin: 6px 0 8px 0;
      padding: 5px 7px;
      background: var(--paper-warm);
      border: 1.5px solid var(--border-bold);
      border-radius: 3px;
      font-size: 10px;
    }
    .hunk-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 3px 0;
      border-bottom: 1px solid var(--border-subtle);
    }
    .hunk-row:last-child {
      border-bottom: none;
    }

    /* ==========================================================================
       PROOF-CARRYING CODE REPORT CARD
       ========================================================================== */
    .proof-card {
      background: var(--paper-white);
      border: 2px solid var(--verified-green);
      box-shadow: 3px 3px 0px var(--verified-green);
      padding: 10px 12px;
      border-radius: 4px;
      margin: 8px 0;
      font-size: 11px;
    }
    .proof-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--verified-green);
      margin-bottom: 6px;
      flex-wrap: wrap;
      gap: 4px;
    }
    .test-result-row {
      display: flex;
      justify-content: space-between;
      padding: 3px 0;
      border-bottom: 1px solid var(--border-subtle);
    }
    .test-result-row:last-child {
      border-bottom: none;
    }

    /* ==========================================================================
       QUICK PROMPTS / BENCHMARK CHIPS
       ========================================================================== */
    .quick-prompts {
      display: flex;
      flex-direction: column;
      gap: 5px;
      margin-top: 8px;
    }
    .quick-chip {
      background: var(--paper-secondary);
      border: 1.5px solid var(--border-bold);
      box-shadow: var(--shadow-sm);
      border-radius: 3px;
      padding: 6px 8px;
      color: var(--ink-black);
      font-size: 11px;
      cursor: pointer;
      text-align: left;
      transition: transform 0.1s ease, box-shadow 0.1s ease;
    }
    .quick-chip:hover {
      background: var(--paper-white);
      transform: translate(-1px, -1px);
      box-shadow: var(--shadow-md);
    }
    .quick-chip:active {
      transform: translate(2px, 2px);
      box-shadow: 0px 0px 0px;
    }

    /* ==========================================================================
       BUTTON SYSTEM (Neo-Brutalist Tactile Buttons)
       ========================================================================== */
    .btn-group {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }
    button {
      background: var(--electric-cobalt);
      color: #ffffff;
      border: 2px solid var(--border-bold);
      box-shadow: var(--shadow-sm);
      padding: 6px 12px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      transition: transform 0.1s ease, box-shadow 0.1s ease;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      white-space: nowrap;
    }
    button:hover:not(:disabled) {
      background: var(--cobalt-hover);
      transform: translate(-1px, -1px);
      box-shadow: var(--shadow-md);
    }
    button:active:not(:disabled) {
      transform: translate(2px, 2px);
      box-shadow: 0px 0px 0px;
    }
    button:disabled {
      opacity: 0.55;
      cursor: not-allowed;
      transform: none !important;
      box-shadow: var(--shadow-sm) !important;
    }

    button.secondary {
      background: var(--paper-secondary);
      color: var(--ink-black);
    }
    button.secondary:hover:not(:disabled) {
      background: var(--paper-white);
    }

    button.danger {
      background: var(--signal-red);
      color: #ffffff;
    }
    button.danger:hover:not(:disabled) {
      background: #b91c1c;
    }

    button.success {
      background: var(--verified-green);
      color: #ffffff;
    }
    button.success:hover:not(:disabled) {
      background: #14532d;
    }

    button.tiny {
      padding: 2px 7px;
      font-size: 9.5px;
      box-shadow: 1px 1px 0px var(--border-bold);
    }

    /* Hero Send Button */
    button#sendBtn {
      background: var(--electric-cobalt);
      box-shadow: var(--shadow-md);
      font-size: 11.5px;
      padding: 7px 14px;
    }

    /* ==========================================================================
       COMMAND INPUT AREA
       ========================================================================== */
    .input-area {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-top: 6px;
    }
    textarea#promptInput {
      width: 100%;
      background: var(--paper-white);
      color: var(--ink-black);
      border: 2px solid var(--border-bold);
      box-shadow: var(--shadow-sm);
      border-radius: 4px;
      padding: 8px 10px;
      font-size: 11.5px;
      resize: vertical;
      min-height: 60px;
      line-height: 1.4;
      outline: none;
      transition: border-color 0.15s ease, box-shadow 0.15s ease;
    }
    textarea#promptInput:focus {
      border-color: var(--electric-cobalt);
      box-shadow: var(--shadow-focus);
    }
    .actions {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
    }

    /* ==========================================================================
       RESPONSIVE ADAPTATIONS (Down to 320px)
       ========================================================================== */
    @media (max-width: 360px) {
      body {
        padding: 6px;
      }
      .brand {
        font-size: 11.5px;
      }
      .step-node {
        flex: 1 1 calc(50% - 4px);
        font-size: 8.5px;
        padding: 3px 2px;
      }
      .model-bar {
        flex-direction: column;
        align-items: stretch;
      }
      select#modelSelect {
        width: 100%;
      }
      .actions {
        flex-direction: column;
        align-items: stretch;
      }
      .actions .btn-group {
        width: 100%;
      }
      .actions button {
        width: 100%;
      }
    }

    /* Reduced Motion */
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        transition: none !important;
        animation: none !important;
        transform: none !important;
      }
    }
  </style>
</head>
<body>
  <!-- BAUHAUS PRODUCT HEADER -->
  <div class="header">
    <div class="header-top">
      <div class="brand">
        <span class="brand-mark" title="FORGE//SENTINEL Bauhaus Emblem">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none">
            <rect x="2" y="3" width="8" height="8" rx="1" fill="#D7263D" stroke="#171717" stroke-width="1.8"/>
            <circle cx="17" cy="7" r="4" fill="#1E4CA1" stroke="#171717" stroke-width="1.8"/>
            <polygon points="12,13 4,21 20,21" fill="#F4B400" stroke="#171717" stroke-width="1.8" stroke-linejoin="round"/>
          </svg>
        </span>
        FORGE//SENTINEL
      </div>
      <div class="status-pills">
        <div id="statusBadge" class="pill offline">Daemon: Offline</div>
        <div id="modelPill" class="pill model">Model: Ready</div>
      </div>
    </div>
    <div class="brand-tagline">Understand First • Plan Intelligently • Change Precisely • Prove Everything</div>
  </div>

  <!-- PROVIDER & MODEL SELECTOR CONTROL BAR -->
  <div class="model-bar">
    <div style="display:flex; align-items:center; gap:6px; flex:1; min-width:0;">
      <span class="model-label">Active Model:</span>
      <select id="modelSelect">
        <option value="">Resolving available models...</option>
      </select>
    </div>
    <button id="configKeysBtn" class="tiny secondary" style="white-space:nowrap;" title="Configure AI Provider API Keys">⚙️ Config Keys</button>
  </div>

  <!-- EIGHT-STAGE EXECUTION PIPELINE -->
  <div class="step-pipeline" id="stepPipeline">
    <div class="step-node active" id="step-idle">01. Idle</div>
    <div class="step-node" id="step-understanding">02. Understand</div>
    <div class="step-node" id="step-retrieving">03. Auction</div>
    <div class="step-node" id="step-searching">04. MRI</div>
    <div class="step-node" id="step-planning">05. Plan</div>
    <div class="step-node" id="step-staging">06. Stage</div>
    <div class="step-node" id="step-testing">07. Test</div>
    <div class="step-node" id="step-completed" style="display: none;">08. Done</div>
    <div class="step-node" id="step-proven">08. Proven</div>
    <div class="step-node" id="step-failed" style="display: none;">Failed</div>
    <div class="step-node" id="step-cancelled" style="display: none;">Cancelled</div>
  </div>

  <!-- CHAT / MESSAGE STREAM -->
  <div id="chat" class="chat-container">
    <div class="message assistant">
      <div class="message-tag">Sentinel Command Center</div>
      <div>Ready. Codebase MRI, Context Auction, Surgical Patch Staging, and Proof-Carrying Code active.</div>
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

  <!-- COMMAND INPUT & ACTIONS -->
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
    const modelSelect = document.getElementById('modelSelect');
    const configKeysBtn = document.getElementById('configKeysBtn');
    const stagedContainer = document.getElementById('stagedContainer');
    const proofContainer = document.getElementById('proofContainer');
    const stepPipeline = document.getElementById('stepPipeline');

    let currentStreamingElem = null;

    modelSelect?.addEventListener('change', () => {
      if (modelSelect.value) {
        vscode.postMessage({ command: 'selectModel', modelName: modelSelect.value });
      }
    });

    configKeysBtn?.addEventListener('click', () => {
      vscode.postMessage({ command: 'openApiKeyConfig' });
    });

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
            statusBadge.textContent = 'Online (8790 + 9099)';
            if (msg.activeModel) {
              modelPill.textContent = msg.activeModel;
            }
          } else if (msg.state === 'degraded_mcp') {
            statusBadge.className = 'pill degraded';
            statusBadge.textContent = 'MCP Offline (9099)';
          } else if (msg.state === 'degraded_daemon') {
            statusBadge.className = 'pill offline';
            statusBadge.textContent = 'Daemon Offline (8790)';
          } else {
            statusBadge.className = 'pill offline';
            statusBadge.textContent = 'Offline (8790 + 9099)';
          }

          if (modelSelect && msg.models && msg.models.length > 0) {
            const currentSelection = msg.modelName || modelSelect.value;
            modelSelect.innerHTML = '';
            for (const m of msg.models) {
              if (!m.isAvailable) continue;
              const opt = document.createElement('option');
              opt.value = m.name;
              opt.textContent = m.displayName;
              if (m.name === currentSelection || (!currentSelection && m.name.includes('gemini-3-8-flash'))) {
                opt.selected = true;
              }
              modelSelect.appendChild(opt);
            }
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
          currentStreamingElem.innerHTML = '<div class="message-tag">Sentinel Agent</div><div class="stream-body"></div>';
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
          userElem.innerHTML = '<div class="message-tag">Developer</div><div>' + escapeHtml(msg.text) + '</div>';
          chat.appendChild(userElem);
          chat.scrollTop = chat.scrollHeight;
          break;

        case 'toolCall':
          const toolBox = document.createElement('div');
          toolBox.className = 'tool-box';
          toolBox.innerHTML = '⚙️ <strong>[Tool Call]</strong> ' + escapeHtml(msg.call.name) + '<code>(' + escapeHtml(JSON.stringify(msg.call.args)) + ')</code>';
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
          logElem.style.fontSize = '10.5px';
          logElem.style.color = 'var(--ink-muted)';
          logElem.style.padding = '1px 4px';
          logElem.textContent = '• ' + msg.message;
          chat.appendChild(logElem);
          chat.scrollTop = chat.scrollHeight;
          break;

        case 'error':
          const errElem = document.createElement('div');
          errElem.className = 'message';
          errElem.style.background = 'var(--tint-red)';
          errElem.style.borderColor = 'var(--signal-red)';
          errElem.style.color = 'var(--signal-red)';
          errElem.innerHTML = '<div class="message-tag" style="color:var(--signal-red);">Error Trapped by Sentinel</div><div>' + escapeHtml(msg.message) + '</div>';
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
        '<li style="margin-bottom:3px;"><code>' + escapeHtml(f.filePath) + '</code> <span class="badge risk-low" style="font-size:8.5px;">' + f.estimatedTokens + ' tok</span> (score: ' + f.score + ') — <span style="color:var(--ink-muted);">' + escapeHtml(f.relevanceRationale) + '</span></li>'
      ).join('');

      let excludedList = r.excludedFiles.map(e =>
        '<li style="margin-bottom:2px;"><code>' + escapeHtml(e.filePath) + '</code>: ' + escapeHtml(e.exclusionReason) + '</li>'
      ).join('');

      const breakdownHtml =
        '<div class="breakdown-grid">' +
          '<span><strong>1. Retrieved Code:</strong> ' + retrievedCodeTok + ' tok</span>' +
          '<span><strong>2. Est. Complete Req:</strong> ' + estimatedReqTok + ' tok</span>' +
          '<span><strong>3. Reserved Output:</strong> ' + reservedOutTok + ' tok</span>' +
          '<span><strong>4. Safety Margin:</strong> ' + safetyMarginTok + ' tok</span>' +
          '<span style="grid-column:span 2; margin-top:2px; font-weight:700;">5. Total Capacity: ' + totalCapacityTok.toLocaleString() + ' tok (Ceiling: ' + totalBudget.toLocaleString() + ' tok)</span>' +
        '</div>';

      receiptBox.innerHTML = 
        '<div class="receipt-title">' +
          '<span>📋 Context Selection Receipt</span>' +
          '<span style="color:var(--electric-cobalt);">' + retrievedCodeTok + ' / ' + codeBudget + ' code tok (' + codePct + '%)</span>' +
        '</div>' +
        '<div class="token-meter"><div class="token-meter-fill" style="width:' + codePct + '%;"></div></div>' +
        breakdownHtml +
        '<details style="cursor:pointer;"><summary><strong>' + r.selectedFiles.length + ' High-Relevance Selected Files</strong></summary>' +
          '<ul style="margin:4px 0; padding-left:16px;">' + selectedList + '</ul>' +
        '</details>' +
        (r.excludedFiles.length > 0 ? 
          '<details style="cursor:pointer; margin-top:4px;"><summary style="color:var(--ink-muted);">' + r.excludedFiles.length + ' Excluded Candidates</summary>' +
            '<ul style="margin:4px 0; padding-left:16px; color:var(--ink-muted);">' + excludedList + '</ul>' +
          '</details>' : '');

      chat.appendChild(receiptBox);
      chat.scrollTop = chat.scrollHeight;
    }

    function renderStagedPatches(patches) {
      stagedContainer.innerHTML = '';
      if (!patches || patches.length === 0) return;

      const title = document.createElement('div');
      title.style.fontWeight = '800';
      title.style.fontSize = '11px';
      title.style.textTransform = 'uppercase';
      title.style.letterSpacing = '0.04em';
      title.style.margin = '10px 0 6px 0';
      title.style.color = 'var(--ink-black)';
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
              '<span>' + escapeHtml(h.header) + '</span>' +
              '<label style="cursor:pointer; font-weight:700;"><input type="checkbox" class="hunk-toggle" data-patch="' + p.patchId + '" data-hunk="' + h.hunkId + '" ' + checked + '> Include</label>' +
            '</div>';
          });
          hunkMarkup += '</div>';
        }

        item.innerHTML = 
          '<div class="patch-header">' +
            '<span class="file-chip">' + escapeHtml(p.filePath) + '</span>' +
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

      let badgeStyle = 'background:var(--tint-green); color:var(--verified-green); border-color:var(--verified-green);';
      if (report.status === 'read_only_completed') {
        badgeStyle = 'background:var(--tint-cobalt); color:var(--electric-cobalt); border-color:var(--electric-cobalt);';
      } else if (report.status === 'failed') {
        badgeStyle = 'background:var(--tint-red); color:var(--signal-red); border-color:var(--signal-red);';
      } else if (report.status === 'partial') {
        badgeStyle = 'background:var(--tint-yellow); color:#854d0e; border-color:var(--bauhaus-yellow);';
      } else if (report.status === 'unverified') {
        badgeStyle = 'background:var(--paper-neutral); color:var(--ink-muted); border-color:var(--border-bold);';
      }

      let testRows = '';
      if (report.status === 'read_only_completed') {
        testRows = '<div style="color:var(--electric-cobalt); font-weight:600;">✓ Read-only architecture inquiry (test suite execution not required).</div>';
      } else if (report.testResults && report.testResults.length > 0) {
        testRows = report.testResults.map(r => {
          const color = r.status === 'passed' ? 'var(--verified-green)' : (r.status === 'failed' ? 'var(--signal-red)' : 'var(--bauhaus-yellow)');
          return '<div class="test-result-row"><span>' + escapeHtml(r.testName) + '</span><strong style="color:' + color + ';">' + r.status.toUpperCase() + '</strong></div>';
        }).join('');
      } else {
        testRows = '<div style="color:var(--ink-muted);">No test executions recorded.</div>';
      }

      const displayStatus = report.status === 'read_only_completed' ? 'READ-ONLY COMPLETED' : report.status.toUpperCase();

      box.innerHTML = 
        '<div class="proof-header">' +
          '<span>🛡️ Proof-Carrying Code Report</span>' +
          '<span class="badge" style="' + badgeStyle + '">' + displayStatus + '</span>' +
        '</div>' +
        '<div style="margin-bottom:6px;"><strong>Modified Files (' + report.filesModified.length + '):</strong> ' + (report.filesModified.join(', ') || 'None') + '</div>' +
        '<div style="margin-bottom:6px;"><strong>Patches:</strong> ' + report.patchesAccepted + ' accepted / ' + report.patchesProposed + ' proposed</div>' +
        '<div style="font-weight:700; margin-top:8px; margin-bottom:4px; text-transform:uppercase; font-size:10px;">Verification Results:</div>' +
        '<div style="background:var(--paper-warm); border:1px solid var(--border-subtle); padding:6px 8px; border-radius:3px;">' + testRows + '</div>' +
        (report.remainingRisks && report.remainingRisks.length > 0 ? 
          '<div style="margin-top:6px; color:#854d0e; background:var(--tint-yellow); border:1px solid var(--bauhaus-yellow); padding:5px 7px; border-radius:3px;">⚠️ <strong>Advisory:</strong> ' + escapeHtml(report.remainingRisks.join('; ')) + '</div>' : '');

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
