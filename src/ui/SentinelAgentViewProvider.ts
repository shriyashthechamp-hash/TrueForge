import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import type { TrueForgeHarnessClient } from '../agent/TrueForgeHarnessClient.js';
import type { CodebaseMri } from '../context/CodebaseMri.js';
import type { ContextAuction } from '../context/ContextAuction.js';
import type { PatchStagingManager } from '../diff/PatchStagingManager.js';
import type { FlightRecorder } from '../flight-recorder/FlightRecorder.js';

export class SentinelAgentViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'forge-sentinel.agentPanel';
  private _view?: vscode.WebviewView;
  private currentAbortController?: AbortController;
  private activeSessionId?: string;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly workspaceRoot: string,
    private readonly patchManager: PatchStagingManager,
    private readonly mri: CodebaseMri,
    private readonly auction: ContextAuction,
    private readonly trueforge: TrueForgeHarnessClient,
    private readonly flightRecorder: FlightRecorder
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
        case 'reviewPatchDiff': {
          await this.handleReviewDiff(message.patchId);
          break;
        }
      }
    });

    this.updateConnectionStatus();
  }

  private async updateConnectionStatus(): Promise<void> {
    try {
      const health = await this.trueforge.checkHealth();
      const models = await this.trueforge.listConfiguredModels();
      this._view?.webview.postMessage({
        type: 'statusUpdate',
        connected: true,
        version: health.version ?? '0.0.0',
        models,
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
    this._view?.webview.postMessage({ type: 'log', message: 'Running Codebase MRI scan...' });
    const files = await this.mri.scan();
    const summary = this.mri.getStructureSummary();
    this._view?.webview.postMessage({
      type: 'mriSummary',
      summary,
    });
    this._view?.webview.postMessage({
      type: 'log',
      message: `Codebase MRI scan complete: ${summary.totalFiles} files, ${summary.totalSymbols} symbols indexed.`,
    });
  }

  private async handleUserPrompt(promptText: string): Promise<void> {
    if (!promptText || promptText.trim() === '') return;

    this.currentAbortController = new AbortController();
    const taskId = `task_${Date.now()}`;
    this.flightRecorder.startTask(taskId, promptText);

    this._view?.webview.postMessage({ type: 'userMessage', text: promptText });
    this._view?.webview.postMessage({ type: 'turnStarted' });

    try {
      this._view?.webview.postMessage({ type: 'log', message: 'Running Context Auction retrieval...' });
      const { receipt, contextBundle } = await this.auction.runAuction(promptText, 16000);

      this._view?.webview.postMessage({
        type: 'contextReceipt',
        receipt,
      });

      this._view?.webview.postMessage({ type: 'log', message: 'Creating TrueForge session...' });
      this.activeSessionId = await this.trueforge.createSession({
        instructions: `You are FORGE//SENTINEL, an expert autonomous coding agent.
You have access to tools via MCP (forge-sentinel-mcp).
To inspect code: search_workspace, find_symbol, read_file.
To stage changes: propose_file_edit, propose_multi_file_edit.
To run tests: run_test_command.
Always explain the purpose, rationale, and expected impact of any changes.`,
      });

      const fullPrompt = `${promptText}\n\n=== RELEVANT CONTEXT (RETRIEVED VIA CONTEXT AUCTION) ===\n${contextBundle}`;

      await this.trueforge.runTurn(
        this.activeSessionId,
        fullPrompt,
        {
          onTokenDelta: (delta) => {
            this._view?.webview.postMessage({ type: 'tokenDelta', delta });
          },
          onToolCall: (call) => {
            this._view?.webview.postMessage({ type: 'toolCall', call });
            this.flightRecorder.record('tool_call', `Agent invoked tool: ${call.name}`, { ...call });
          },
          onToolResponse: (resp) => {
            this._view?.webview.postMessage({ type: 'toolResponse', resp });
            this.flightRecorder.record('tool_result', `Tool completed`, { ...resp });
            this.refreshStagedPatchesUI();
          },
          onTurnComplete: (result) => {
            this._view?.webview.postMessage({ type: 'turnDone', result });
            this.compileAndSendProofOfChange(promptText, taskId);
          },
        },
        this.currentAbortController.signal
      );
    } catch (err: any) {
      if (err.name === 'AbortError') {
        this._view?.webview.postMessage({ type: 'log', message: 'Turn was cancelled by user.' });
      } else {
        this._view?.webview.postMessage({ type: 'error', message: err.message });
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
        hunks: p.hunks,
      })),
    });
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
      `Sentinel Review: ${patch.filePath} (Proposed Diff)`
    );
  }

  private async handlePatchDecision(patchId: string, decision: 'accept' | 'reject'): Promise<void> {
    const patch = this.patchManager.getPatch(patchId);
    if (!patch) return;

    if (decision === 'accept') {
      try {
        await this.patchManager.applyPatch(patchId);
        vscode.window.showInformationMessage(`FORGE//SENTINEL: Applied patch for "${patch.filePath}".`);
      } catch (err: any) {
        vscode.window.showErrorMessage(`Apply failed: ${err.message}`);
      }
    } else {
      this.patchManager.setPatchDecision(patchId, 'reject');
      vscode.window.showInformationMessage(`FORGE//SENTINEL: Rejected patch for "${patch.filePath}".`);
    }

    this.refreshStagedPatchesUI();
  }

  private compileAndSendProofOfChange(instruction: string, taskId: string): void {
    const staged = this.patchManager.getAllStaged();
    const accepted = staged.filter((p) => p.status === 'applied');
    const report = this.flightRecorder.compileProofOfChange({
      filesModified: accepted.map((p) => p.filePath),
      patchesProposed: staged.length,
      patchesAccepted: accepted.length,
    });

    this._view?.webview.postMessage({
      type: 'proofOfChange',
      report,
    });
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
    img-src ${webview.cspSource} https:;
    font-src ${webview.cspSource};
  ">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>FORGE//SENTINEL</title>
  <style>
    :root {
      --bg: #0d1117;
      --card-bg: #161b22;
      --border: #30363d;
      --text: #c9d1d9;
      --text-muted: #8b949e;
      --cobalt: #3b82f6;
      --cobalt-hover: #2563eb;
      --lime: #10b981;
      --amber: #f59e0b;
      --crimson: #ef4444;
      --violet: #8b5cf6;
    }
    body {
      background-color: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      margin: 0;
      padding: 12px;
      font-size: 13px;
      line-height: 1.5;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 10px;
      border-bottom: 1px solid var(--border);
      margin-bottom: 12px;
    }
    .brand {
      font-weight: 700;
      letter-spacing: 0.05em;
      color: #ffffff;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .status-badge {
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 12px;
      background: #1f2937;
      border: 1px solid var(--border);
    }
    .status-badge.online {
      color: var(--lime);
      border-color: rgba(16, 185, 129, 0.3);
    }
    .status-badge.offline {
      color: var(--crimson);
      border-color: rgba(239, 68, 68, 0.3);
    }
    .chat-container {
      display: flex;
      flex-direction: column;
      gap: 10px;
      max-height: 380px;
      overflow-y: auto;
      margin-bottom: 12px;
    }
    .message {
      padding: 8px 12px;
      border-radius: 6px;
      font-size: 12px;
    }
    .message.user {
      background: #1e293b;
      border-left: 3px solid var(--cobalt);
    }
    .message.assistant {
      background: var(--card-bg);
      border-left: 3px solid var(--violet);
    }
    .tool-box {
      background: #0f172a;
      border: 1px solid #334155;
      padding: 6px 10px;
      border-radius: 4px;
      font-family: monospace;
      font-size: 11px;
      color: #93c5fd;
      margin: 4px 0;
    }
    .receipt-box {
      background: #111827;
      border: 1px solid #374151;
      padding: 8px;
      border-radius: 4px;
      font-size: 11px;
      margin: 8px 0;
    }
    .receipt-header {
      font-weight: bold;
      color: var(--amber);
      margin-bottom: 4px;
    }
    .staged-patch {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 10px;
      margin-bottom: 8px;
    }
    .patch-title {
      font-weight: 600;
      color: #ffffff;
      display: flex;
      justify-content: space-between;
      margin-bottom: 4px;
    }
    .patch-purpose {
      font-size: 11px;
      color: var(--text-muted);
      margin-bottom: 8px;
    }
    .btn-group {
      display: flex;
      gap: 6px;
    }
    button {
      background: var(--cobalt);
      color: #ffffff;
      border: none;
      padding: 6px 12px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 500;
    }
    button:hover {
      background: var(--cobalt-hover);
    }
    button.secondary {
      background: #374151;
    }
    button.secondary:hover {
      background: #4b5563;
    }
    button.danger {
      background: #991b1b;
    }
    button.danger:hover {
      background: #b91c1c;
    }
    button.success {
      background: #065f46;
    }
    button.success:hover {
      background: #047857;
    }
    .input-area {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    textarea {
      width: 100%;
      box-sizing: border-box;
      background: var(--card-bg);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 8px;
      font-size: 12px;
      resize: vertical;
      min-height: 60px;
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
    <div id="statusBadge" class="status-badge offline">Checking...</div>
  </div>

  <div id="chat" class="chat-container">
    <div class="message assistant">
      <strong>Sentinel Agent:</strong> Command Center active. TrueForge agent loop, MCP tools, and Context Auction standing by.
    </div>
  </div>

  <div id="stagedContainer"></div>
  <div id="proofContainer"></div>

  <div class="input-area">
    <textarea id="promptInput" placeholder="Enter instructions (e.g. 'Add a new built-in CLI command flask config...'). Use @file and @symbol for explicit focus."></textarea>
    <div class="actions">
      <div class="btn-group">
        <button id="scanBtn" class="secondary" title="Run structural Codebase MRI">Scan MRI</button>
        <button id="cancelBtn" class="danger" style="display: none;">Cancel</button>
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
    const stagedContainer = document.getElementById('stagedContainer');
    const proofContainer = document.getElementById('proofContainer');

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

    window.addEventListener('message', (event) => {
      const msg = event.data;
      switch (msg.type) {
        case 'statusUpdate':
          if (msg.connected) {
            statusBadge.className = 'status-badge online';
            statusBadge.textContent = 'TrueForge: Online';
          } else {
            statusBadge.className = 'status-badge offline';
            statusBadge.textContent = 'TrueForge: Offline';
          }
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
          userElem.innerHTML = '<strong>User:</strong> ' + msg.text;
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
          const r = msg.receipt;
          const receiptBox = document.createElement('div');
          receiptBox.className = 'receipt-box';
          receiptBox.innerHTML = '<div class="receipt-header">📋 Context Selection Receipt (' + r.totalTokensUsed + ' / ' + r.tokenBudget + ' tokens)</div>' +
            '<div><strong>Selected:</strong> ' + r.selectedFiles.map(f => f.filePath + ' (' + f.score + 'pts)').join(', ') + '</div>' +
            (r.excludedFiles.length > 0 ? '<div style="color:var(--text-muted); margin-top:2px;"><strong>Excluded:</strong> ' + r.excludedFiles.length + ' candidate files</div>' : '');
          chat.appendChild(receiptBox);
          chat.scrollTop = chat.scrollHeight;
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
      }
    });

    function renderStagedPatches(patches) {
      stagedContainer.innerHTML = '';
      if (!patches || patches.length === 0) return;

      const title = document.createElement('h4');
      title.style.margin = '10px 0 6px 0';
      title.textContent = 'Proposed Surgical Patches (' + patches.length + ')';
      stagedContainer.appendChild(title);

      for (const p of patches) {
        const item = document.createElement('div');
        item.className = 'staged-patch';
        item.innerHTML = '<div class="patch-title"><span>' + p.filePath + '</span><span style="font-size:11px; color:var(--amber);">' + p.status.toUpperCase() + '</span></div>' +
          '<div class="patch-purpose">' + p.purpose + '</div>' +
          '<div class="btn-group">' +
            '<button class="secondary review-btn" data-id="' + p.patchId + '">Review Diff</button>' +
            '<button class="success accept-btn" data-id="' + p.patchId + '">Accept</button>' +
            '<button class="danger reject-btn" data-id="' + p.patchId + '">Reject</button>' +
          '</div>';

        item.querySelector('.review-btn').addEventListener('click', () => {
          vscode.postMessage({ command: 'reviewPatchDiff', patchId: p.patchId });
        });
        item.querySelector('.accept-btn').addEventListener('click', () => {
          vscode.postMessage({ command: 'acceptPatch', patchId: p.patchId });
        });
        item.querySelector('.reject-btn').addEventListener('click', () => {
          vscode.postMessage({ command: 'rejectPatch', patchId: p.patchId });
        });

        stagedContainer.appendChild(item);
      }
    }

    function renderProofOfChange(report) {
      proofContainer.innerHTML = '';
      const box = document.createElement('div');
      box.style.background = '#064e3b';
      box.style.border = '1px solid #059669';
      box.style.padding = '10px';
      box.style.borderRadius = '6px';
      box.style.margin = '10px 0';

      box.innerHTML = '<div style="font-weight:bold; color:#a7f3d0; margin-bottom:4px;">✅ Proof of Change Report (Status: ' + report.status.toUpperCase() + ')</div>' +
        '<div style="font-size:12px;"><strong>Modified Files:</strong> ' + report.filesModified.join(', ') + '</div>' +
        '<div style="font-size:12px;"><strong>Tests Executed:</strong> ' + (report.testsExecuted.length > 0 ? report.testsExecuted.join(', ') : 'None') + '</div>' +
        '<div style="font-size:12px;"><strong>Tests Passed:</strong> ' + (report.testsPassed ? '<span style="color:#6ee7b7">PASSED</span>' : '<span style="color:#fca5a5">UNVERIFIED/FAILED</span>') + '</div>';

      proofContainer.appendChild(box);
    }
  </script>
</body>
</html>`;
  }
}
