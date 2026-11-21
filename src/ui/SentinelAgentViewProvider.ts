import { webviewClientScript } from './webviewScript';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

function logRuntime(msg: string): void {
  try {
    const entry = `[${new Date().toISOString()}] ${msg}\n`;
    fs.appendFileSync('/tmp/forge_sentinel_runtime.log', entry, 'utf8');
  } catch {}
}

const TRACE_LOG_FILE = '/tmp/forge_sentinel_trace.log';

export interface TraceRecord {
  stage: string;
  stageName: string;
  correlationId: string;
  timestamp: string;
  success: boolean;
  details?: Record<string, any>;
  error?: string;
  stack?: string;
}

export function logTrace(record: TraceRecord): void {
  try {
    const entry = JSON.stringify(record) + '\n';
    fs.appendFileSync(TRACE_LOG_FILE, entry, 'utf8');
    const detailsStr = record.details ? ` ${JSON.stringify(record.details)}` : '';
    const errStr = record.error ? ` ERROR: ${record.error}` : '';
    logRuntime(`[TRACE ${record.stage}] [${record.correlationId}] success=${record.success}: ${record.stageName}${detailsStr}${errStr}`);
  } catch (err) {
    console.error('Failed to write trace log:', err);
  }
}
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
  private readonly disposables: vscode.Disposable[] = [];

  public dispose(): void {
    while (this.disposables.length) {
      const d = this.disposables.pop();
      d?.dispose();
    }
  }

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
    logRuntime(`resolveWebviewView called. visible=${webviewView.visible}`);

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.onDidReceiveMessage(async (message) => {
      logRuntime(`onDidReceiveMessage received: command=${message?.command || message?.type || 'unknown'}`);
      switch (message.command) {
        case 'submitPrompt': {
          logRuntime(`submitPrompt received. text length=${message.text?.length}, correlationId=${message.correlationId}`);
          await this.handleUserPrompt(message.text, message.correlationId, message.clientTrace);
          break;
        }
        case 'traceStageP': {
          logTrace({
            stage: 'P',
            stageName: 'Final assistant message renders in webview',
            correlationId: message.correlationId || 'unknown',
            timestamp: new Date().toISOString(),
            success: true,
          });
          break;
        }
        case 'cancelTurn': {
          this.handleCancelTurn(message.correlationId);
          break;
        }
        case 'scanWorkspace': {
          await this.handleScanWorkspace(message.correlationId);
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
          logRuntime('Received refreshStatus command from webview');
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
          await this.handleOpenApiKeyConfig(message.correlationId);
          break;
        }
        case 'clientError': {
          logRuntime(`Webview reported client error: ${message.error}`);
          break;
        }
      }
    });

    if (this.connectionManager) {
      this.connectionManager.setStatusCallback((status: DetailedConnectionStatus) => {
        logRuntime(`connectionManager.onStatusChange callback fired: connected=${status.connected}`);
        this.postStatusUpdate(status);
      });
    }

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);
    this.updateConnectionStatus();
  }

  public setConnectionManager(manager: ConnectionLifecycleManager): void {
    this.connectionManager = manager;
    this.connectionManager.setStatusCallback((status: DetailedConnectionStatus) => {
      this.postStatusUpdate(status);
    });
  }

  public async updateConnectionStatus(): Promise<DetailedConnectionStatus> {
    if (this.connectionManager) {
      const status = await this.connectionManager.triggerImmediateCheck();
      logRuntime(`updateConnectionStatus completed: connected=${status.connected}, state=${status.state}`);
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
    logRuntime(`postStatusUpdate called: connected=${status.connected}, state=${status.state}`);
    this._view?.webview.postMessage({
      type: 'statusUpdate',
      ...status,
    }).then(
      (delivered) => logRuntime(`postStatusUpdate delivered=${delivered}`),
      (err) => logRuntime(`postStatusUpdate error=${err}`)
    );
  }

  private async handleOpenApiKeyConfig(correlationId: string = `config_${Date.now()}`): Promise<void> {
    logRuntime(`[CONFIG_KEYS] [${correlationId}] Opening API key configuration quickpick...`);
    logTrace({
      stage: 'CONFIG_KEYS',
      stageName: 'Open API Key Configuration',
      correlationId,
      timestamp: new Date().toISOString(),
      success: true,
    });
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

  private async handleScanWorkspace(correlationId: string = `scan_${Date.now()}`): Promise<void> {
    logRuntime(`[SCAN_MRI] [${correlationId}] Running Codebase MRI structural scan...`);
    logTrace({
      stage: 'SCAN_START',
      stageName: 'Codebase MRI scan initiated',
      correlationId,
      timestamp: new Date().toISOString(),
      success: true,
    });
    this.postExecutionStep('searching');
    this._view?.webview.postMessage({ type: 'log', message: 'Running Codebase MRI structural scan...' });
    await this.mri.scan();
    const summary = this.mri.getStructureSummary();
    logTrace({
      stage: 'SCAN_DONE',
      stageName: 'Codebase MRI scan completed',
      correlationId,
      timestamp: new Date().toISOString(),
      success: true,
      details: { totalFiles: summary.totalFiles, totalSymbols: summary.totalSymbols },
    });
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

  public async handleUserPrompt(
    promptText: string,
    correlationId: string = `turn_${Date.now()}`,
    clientTrace?: any[]
  ): Promise<void> {
    // Record client stages A-D if passed from webview
    if (clientTrace && Array.isArray(clientTrace)) {
      for (const t of clientTrace) {
        logTrace(t);
      }
    }

    // Stage E: Extension host receives the message
    logTrace({
      stage: 'E',
      stageName: 'Extension host receives the message',
      correlationId,
      timestamp: new Date().toISOString(),
      success: true,
      details: { promptLength: promptText?.length ?? 0 },
    });

    // Stage F: Message type and payload validated
    if (!promptText || promptText.trim() === '') {
      logTrace({
        stage: 'F',
        stageName: 'Message type and payload validated',
        correlationId,
        timestamp: new Date().toISOString(),
        success: false,
        error: 'Prompt text is empty or missing',
      });
      return;
    }
    logTrace({
      stage: 'F',
      stageName: 'Message type and payload validated',
      correlationId,
      timestamp: new Date().toISOString(),
      success: true,
      details: { promptLength: promptText.length },
    });

    // Stage G: Daemon preflight check
    const connStatus = await this.updateConnectionStatus();
    if (!connStatus.connected) {
      logTrace({
        stage: 'G',
        stageName: 'Daemon preflight succeeds',
        correlationId,
        timestamp: new Date().toISOString(),
        success: false,
        error: connStatus.error || 'TrueForge daemon or Sentinel MCP server is unreachable.',
      });
      this.postExecutionStep('failed');
      const err = connStatus.error || 'TrueForge daemon or Sentinel MCP server is unreachable.';
      this._view?.webview.postMessage({ type: 'userMessage', text: promptText });
      this._view?.webview.postMessage({
        type: 'agentMessage',
        text: `⚠️ **[Connection Error]** ${err}\n\nPlease ensure both the TrueForge daemon (\`http://localhost:8790\`) and Sentinel MCP server (\`port ${this.mcpServer?.getPort() ?? 9099}\`) are online.`,
      });
      this._view?.webview.postMessage({ type: 'turnEnded' });
      return;
    }
    logTrace({
      stage: 'G',
      stageName: 'Daemon preflight succeeds',
      correlationId,
      timestamp: new Date().toISOString(),
      success: true,
      details: {
        daemonOnline: connStatus.daemonOnline,
        mcpOnline: connStatus.mcpOnline,
        activeModel: connStatus.activeModel,
      },
    });

    this.currentAbortController = new AbortController();
    const taskId = `task_${Date.now()}`;
    this.flightRecorder.startTask(taskId, promptText);

    this._view?.webview.postMessage({ type: 'userMessage', text: promptText });
    this._view?.webview.postMessage({ type: 'turnStarted' });
    this.postExecutionStep('understanding');

    let accumulatedTokens = 0;
    let hasLoggedFirstChunk = false;

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

      // Stage H: TrueForge client invocation begins
      logTrace({
        stage: 'H',
        stageName: 'TrueForge client invocation begins',
        correlationId,
        timestamp: new Date().toISOString(),
        success: true,
        details: { model: authoritative.name, budget: effectiveBudget },
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

      // Stage I: TrueForge receives the request
      logTrace({
        stage: 'I',
        stageName: 'TrueForge receives the request',
        correlationId,
        timestamp: new Date().toISOString(),
        success: true,
        details: { sessionId: this.activeSessionId },
      });

      const fullPrompt = `${promptText}\n\n=== RELEVANT CONTEXT (RETRIEVED VIA CONTEXT AUCTION) ===\n${contextBundle}`;

      // Stage J: Agent turn is created
      logTrace({
        stage: 'J',
        stageName: 'Agent turn is created',
        correlationId,
        timestamp: new Date().toISOString(),
        success: true,
        details: { sessionId: this.activeSessionId, promptLength: fullPrompt.length },
      });

      // Stage K: Model request begins
      logTrace({
        stage: 'K',
        stageName: 'Model request begins',
        correlationId,
        timestamp: new Date().toISOString(),
        success: true,
        details: { model: authoritative.name },
      });

      for (let attempt = 0; attempt < 3; attempt++) {
        let shouldRetryTransient = false;
        let transientErrorObj: Error | undefined;
        let hasExecutedSideEffectTools = false;

        await this.trueforge.runTurn(
          this.activeSessionId,
          fullPrompt,
          {
            onTokenDelta: (delta) => {
              if (!hasLoggedFirstChunk) {
                hasLoggedFirstChunk = true;
                // Stage L: Model response arrives
                logTrace({
                  stage: 'L',
                  stageName: 'Model response arrives',
                  correlationId,
                  timestamp: new Date().toISOString(),
                  success: true,
                  details: { firstChunkLength: delta.length },
                });
              }
              accumulatedTokens += delta.length;
              this._view?.webview.postMessage({ type: 'tokenDelta', delta });
            },
            onToolCall: (call) => {
              // Stage M: Tool execution begins
              logTrace({
                stage: 'M',
                stageName: 'Tool execution begins',
                correlationId,
                timestamp: new Date().toISOString(),
                success: true,
                details: { toolName: call.name, args: call.args },
              });
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
              logTrace({
                stage: 'M_RESP',
                stageName: 'Tool execution completed',
                correlationId,
                timestamp: new Date().toISOString(),
                success: true,
                details: { respId: resp.id },
              });
              this.recordedToolResults.push({ id: resp.id, result: resp.result });
              this._view?.webview.postMessage({ type: 'toolResponse', resp });
              this.flightRecorder.record('tool_result', `Tool completed`, { ...resp });
              this.refreshStagedPatchesUI();
              this.flightRecorderTreeProvider?.refresh();
            },
            onTurnComplete: (result) => {
              // Stage N: Streaming response reaches the extension
              logTrace({
                stage: 'N',
                stageName: 'Streaming response reaches the extension',
                correlationId,
                timestamp: new Date().toISOString(),
                success: !result.error,
                details: { accumulatedTokens },
              });
              // Stage O: Response reaches the webview
              logTrace({
                stage: 'O',
                stageName: 'Response reaches the webview',
                correlationId,
                timestamp: new Date().toISOString(),
                success: !result.error,
                details: { accumulatedTokens },
              });

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

              // Stage Q: Flight Recorder records the actual turn
              this.flightRecorder.record('turn_done', `Agent completed turn for prompt: ${promptText.slice(0, 50)}`, {
                taskId,
                accumulatedTokens,
                status: result.status,
              });
              logTrace({
                stage: 'Q',
                stageName: 'Flight Recorder records the actual turn',
                correlationId,
                timestamp: new Date().toISOString(),
                success: true,
                details: { taskId, eventsRecorded: this.flightRecorder.getEvents().length },
              });

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
      logTrace({
        stage: 'ERROR',
        stageName: 'Exception in handleUserPrompt',
        correlationId,
        timestamp: new Date().toISOString(),
        success: false,
        error: err.message,
        stack: err.stack,
      });
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

  private handleCancelTurn(correlationId: string = `cancel_${Date.now()}`): void {
    logRuntime(`[CANCEL_TURN] [${correlationId}] Aborting turn...`);
    logTrace({
      stage: 'CANCEL_TURN',
      stageName: 'Cancel Turn initiated',
      correlationId,
      timestamp: new Date().toISOString(),
      success: true,
    });
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
    const lastStatus = this.connectionManager?.getLastStatus();
    logRuntime(`_getHtmlForWebview called. lastStatus=${JSON.stringify(lastStatus)}`);

    let initialBadgeClass = 'pill online';
    let initialBadgeText = 'Online (8790 + 9099)';
    let initialModelText = 'Gemini 3.8 Flash (Google)';
    let initialModelOptions = '<option value="google-gemini/gemini-3-8-flash" selected>Gemini 3.8 Flash (Google)</option>';

    if (lastStatus) {
      if (lastStatus.connected) {
        initialBadgeClass = 'pill online';
        initialBadgeText = 'Online (8790 + 9099)';
      } else if (lastStatus.state === 'degraded_mcp') {
        initialBadgeClass = 'pill degraded';
        initialBadgeText = 'MCP Offline (9099)';
      } else if (lastStatus.state === 'degraded_daemon') {
        initialBadgeClass = 'pill offline';
        initialBadgeText = 'Daemon Offline (8790)';
      } else {
        initialBadgeClass = 'pill offline';
        initialBadgeText = 'Offline (8790 + 9099)';
      }

      if (lastStatus.activeModel) {
        initialModelText = lastStatus.activeModel;
      }

      if (lastStatus.models && lastStatus.models.length > 0) {
        initialModelOptions = lastStatus.models
          .filter((m) => m.isAvailable)
          .map((m) => {
            const isSelected = m.displayName === lastStatus.activeModel || m.name === lastStatus.modelName;
            return `<option value="${m.name}" ${isSelected ? 'selected' : ''}>${m.displayName}</option>`;
          })
          .join('\n');
      } else if (lastStatus.activeModel) {
        initialModelOptions = `<option value="${lastStatus.modelName || 'google-gemini/gemini-3-8-flash'}" selected>${lastStatus.activeModel}</option>`;
      }
    }

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} https: data:; font-src ${webview.cspSource};">
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
      padding: 8px;
      font-size: 12px;
      line-height: 1.45;
      overflow-x: hidden;
      display: flex;
      flex-direction: column;
      height: 100vh;
      box-sizing: border-box;
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
      flex: 1 1 auto;
      min-height: 80px;
      overflow-y: auto;
      margin-bottom: 6px;
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

    /* Markdown Headings in Messages */
    .heading-h1 {
      font-size: 15px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      border-bottom: 2px solid var(--border-bold);
      padding-bottom: 3px;
      margin: 10px 0 6px 0;
      color: var(--ink-black);
    }
    .heading-h2 {
      font-size: 13.5px;
      font-weight: 700;
      border-bottom: 1.5px solid var(--border-subtle);
      padding-bottom: 2px;
      margin: 9px 0 5px 0;
      color: var(--ink-black);
    }
    .heading-h3 {
      font-size: 12.5px;
      font-weight: 700;
      margin: 7px 0 3px 0;
      color: var(--electric-cobalt);
    }
    .heading-h4, .heading-h5, .heading-h6 {
      font-size: 11.5px;
      font-weight: 700;
      margin: 6px 0 2px 0;
      color: var(--ink-muted);
    }

    /* Paragraphs and Text */
    .message-paragraph {
      margin: 0 0 6px 0;
      line-height: 1.55;
      font-size: 11.5px;
      word-break: break-word;
    }
    .message-paragraph:last-child {
      margin-bottom: 0;
    }

    /* Inline Code */
    .inline-code {
      background: var(--paper-warm);
      border: 1px solid var(--border-subtle);
      color: var(--ink-black);
      padding: 1px 4px;
      border-radius: 3px;
      font-family: var(--font-mono);
      font-size: 11px;
    }

    /* Fenced Code Blocks */
    .code-block-wrapper {
      background: #18181b;
      border: 2px solid var(--border-bold);
      box-shadow: var(--shadow-sm);
      border-radius: 3px;
      margin: 8px 0;
      overflow: hidden;
    }
    .code-block-wrapper.streaming-code {
      border-color: var(--electric-cobalt);
    }
    .code-block-header {
      background: #27272a;
      border-bottom: 1px solid #3f3f46;
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 3px 8px;
      font-family: var(--font-mono);
    }
    .code-lang-tag {
      font-size: 9.5px;
      font-weight: 700;
      color: var(--bauhaus-yellow);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .copy-code-btn {
      background: var(--paper-warm);
      color: var(--ink-black);
      border: 1px solid var(--border-bold);
      padding: 2px 6px;
      font-size: 9px;
      font-weight: 700;
      cursor: pointer;
      text-transform: uppercase;
      border-radius: 2px;
      transition: background 0.15s ease;
    }
    .copy-code-btn:hover {
      background: var(--paper-white);
    }
    .code-pre {
      margin: 0;
      padding: 8px 10px;
      overflow-x: auto;
      background: #18181b;
    }
    .code-content {
      color: #fafafa;
      font-family: var(--font-mono);
      font-size: 11px;
      line-height: 1.45;
      white-space: pre;
    }

    /* Tables */
    .table-container {
      width: 100%;
      overflow-x: auto;
      margin: 8px 0;
      border: 2px solid var(--border-bold);
      box-shadow: var(--shadow-sm);
      border-radius: 3px;
    }
    .bauhaus-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 11px;
      background: var(--paper-white);
    }
    .bauhaus-table th {
      background: var(--paper-warm);
      border-bottom: 2px solid var(--border-bold);
      border-right: 1px solid var(--border-subtle);
      padding: 5px 7px;
      text-align: left;
      font-weight: 700;
      text-transform: uppercase;
      font-size: 9.5px;
      letter-spacing: 0.03em;
    }
    .bauhaus-table th:last-child {
      border-right: none;
    }
    .bauhaus-table td {
      border-bottom: 1px solid var(--border-subtle);
      border-right: 1px solid var(--border-subtle);
      padding: 4px 7px;
      font-size: 11px;
    }
    .bauhaus-table td:last-child {
      border-right: none;
    }
    .bauhaus-table tr:last-child td {
      border-bottom: none;
    }
    .bauhaus-table tr:nth-child(even) td {
      background: var(--paper-secondary);
    }

    /* Blockquotes */
    .bauhaus-quote {
      border-left: 3.5px solid var(--electric-cobalt);
      background: var(--tint-cobalt);
      margin: 6px 0;
      padding: 6px 9px;
      color: var(--ink-black);
      font-style: italic;
      font-size: 11.5px;
      border-radius: 0 3px 3px 0;
    }

    /* Lists */
    .bauhaus-ul, .bauhaus-ol {
      margin: 5px 0 6px 0;
      padding-left: 18px;
      font-size: 11.5px;
      line-height: 1.5;
    }
    .bauhaus-ul-nested {
      margin: 2px 0;
      padding-left: 16px;
    }
    .bauhaus-ul li, .bauhaus-ol li {
      margin-bottom: 2px;
    }
    .task-list-item {
      display: flex;
      align-items: center;
      gap: 5px;
      cursor: default;
    }
    .task-checkbox {
      margin: 0;
      accent-color: var(--electric-cobalt);
    }

    /* Links */
    .bauhaus-link {
      color: var(--electric-cobalt);
      text-decoration: underline;
      font-weight: 600;
    }
    .bauhaus-link:hover {
      color: var(--cobalt-hover);
    }

    /* Divider */
    .bauhaus-divider {
      border: none;
      height: 2px;
      background: var(--border-bold);
      margin: 8px 0;
    }

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

    /* Tool Response Card */
    .tool-response-box {
      background: var(--paper-white);
      border: 2px solid var(--border-bold);
      box-shadow: var(--shadow-sm);
      border-radius: 4px;
      margin-top: 4px;
      overflow: hidden;
    }
    .tool-response-header {
      padding: 4px 8px;
      background: var(--tint-green);
      border-bottom: 1.5px solid var(--border-bold);
      font-size: 10px;
      font-weight: 700;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .tool-response-content {
      padding: 6px 8px;
      font-family: var(--font-mono);
      font-size: 10.5px;
      max-height: 160px;
      overflow-y: auto;
      white-space: pre-wrap;
      background: var(--paper-warm);
      border-top: 1px solid var(--border-subtle);
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
      margin-top: auto;
      flex-shrink: 0;
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
  <div id="runtimeErrorBanner" style="display:none; background:#FEE2E2; color:#D7263D; border:2px solid #D7263D; padding:8px 10px; margin-bottom:8px; font-weight:700; font-size:11px; border-radius:4px; box-shadow:2px 2px 0px #171717;"></div>
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
        <div id="statusBadge" class="${initialBadgeClass}">${initialBadgeText}</div>
        <div id="modelPill" class="pill model">${initialModelText}</div>
      </div>
    </div>
    <div class="brand-tagline">Understand First • Plan Intelligently • Change Precisely • Prove Everything</div>
  </div>

  <!-- PROVIDER & MODEL SELECTOR CONTROL BAR -->
  <div class="model-bar">
    <div style="display:flex; align-items:center; gap:6px; flex:1; min-width:0;">
      <span class="model-label">Active Model:</span>
      <select id="modelSelect">
        ${initialModelOptions}
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
${webviewClientScript}
  </script>
</body>
</html>`;
  }
}
