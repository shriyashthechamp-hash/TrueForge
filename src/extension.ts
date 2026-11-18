import * as path from 'node:path';
import * as vscode from 'vscode';
import { TrueForgeHarnessClient } from './agent/TrueForgeHarnessClient.js';
import { ConnectionLifecycleManager } from './agent/ConnectionLifecycleManager.js';
import { CodebaseMri } from './context/CodebaseMri.js';
import { ContextAuction } from './context/ContextAuction.js';
import { PatchStagingManager } from './diff/PatchStagingManager.js';
import { FlightRecorder } from './flight-recorder/FlightRecorder.js';
import { SentinelMcpServer } from './mcp/SentinelMcpServer.js';
import { ModelRescue } from './resilience/ModelRescue.js';
import { FlightRecorderTreeDataProvider } from './ui/FlightRecorderTreeDataProvider.js';
import { InlineEditController } from './ui/InlineEditController.js';
import { SentinelAgentViewProvider } from './ui/SentinelAgentViewProvider.js';
import { StagedPatchesTreeDataProvider } from './ui/StagedPatchesTreeDataProvider.js';

let mcpServerInstance: SentinelMcpServer | null = null;
let connectionManagerInstance: ConnectionLifecycleManager | null = null;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  const workspaceRoot = workspaceFolders && workspaceFolders.length > 0
    ? workspaceFolders[0].uri.fsPath
    : process.cwd();

  const config = vscode.workspace.getConfiguration('forgeSentinel');
  const trueforgeUrl = config.get<string>('trueforgeUrl', 'http://localhost:8790');
  const trueforgeToken = config.get<string>('trueforgeToken', 'trueforge-standalone');
  const tokenBudget = config.get<number>('contextBudgetTokens', 16000);

  const patchManager = new PatchStagingManager(workspaceRoot);
  const mri = new CodebaseMri(workspaceRoot);
  const auction = new ContextAuction(workspaceRoot, mri, tokenBudget);
  const flightRecorder = new FlightRecorder();
  const modelRescue = new ModelRescue();
  const trueforgeClient = new TrueForgeHarnessClient(trueforgeUrl, trueforgeToken);

  const stagedPatchesTreeProvider = new StagedPatchesTreeDataProvider(patchManager);
  const flightRecorderTreeProvider = new FlightRecorderTreeDataProvider(flightRecorder);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('forge-sentinel.stagedPatches', stagedPatchesTreeProvider),
    vscode.window.registerTreeDataProvider('forge-sentinel.flightRecorder', flightRecorderTreeProvider)
  );

  const mcpPort = config.get<number>('mcpPort', 9099);
  mcpServerInstance = new SentinelMcpServer(workspaceRoot, patchManager, mri, auction, mcpPort);

  try {
    await mcpServerInstance.start();
  } catch (err) {
    console.warn('FORGE//SENTINEL: MCP Server initialization notice:', err);
  }

  connectionManagerInstance = new ConnectionLifecycleManager(
    trueforgeClient,
    mcpServerInstance,
    workspaceRoot
  );
  connectionManagerInstance.startMonitoring();

  const agentViewProvider = new SentinelAgentViewProvider(
    context.extensionUri,
    workspaceRoot,
    patchManager,
    mri,
    auction,
    trueforgeClient,
    flightRecorder,
    stagedPatchesTreeProvider,
    flightRecorderTreeProvider,
    mcpServerInstance,
    connectionManagerInstance
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SentinelAgentViewProvider.viewType,
      agentViewProvider
    )
  );

  const inlineController = new InlineEditController(
    context,
    patchManager,
    auction,
    trueforgeClient,
    flightRecorder
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('forge-sentinel.inlineEdit', async () => {
      await inlineController.triggerInlineEdit();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('forge-sentinel.openPanel', async () => {
      await vscode.commands.executeCommand('forge-sentinel.agentPanel.focus');
    }),
    vscode.commands.registerCommand('forge-sentinel.analyzeArchitecture', async () => {
      await vscode.commands.executeCommand('forge-sentinel.agentPanel.focus');
      await agentViewProvider.handleUserPrompt('Analyze this repository and explain its architecture.');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('forge-sentinel.openPatchDiff', async (patchId: string) => {
      const patch = patchManager.getPatch(patchId);
      if (patch) {
        const fileUri = vscode.Uri.file(patch.absolutePath);
        const tempProposed = vscode.Uri.parse(`untitled:${patch.filePath}.proposed`);
        const doc = await vscode.workspace.openTextDocument(tempProposed);
        const edit = new vscode.WorkspaceEdit();
        edit.replace(tempProposed, new vscode.Range(0, 0, doc.lineCount, 0), patch.proposedContent);
        await vscode.workspace.applyEdit(edit);
        await vscode.commands.executeCommand(
          'vscode.diff',
          fileUri,
          tempProposed,
          `Sentinel Review: ${path.basename(patch.filePath)} (Proposed Diff)`
        );
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('forge-sentinel.indexWorkspace', async () => {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'FORGE//SENTINEL: Scanning Codebase MRI...',
          cancellable: false,
        },
        async () => {
          await mri.scan();
          const summary = mri.getStructureSummary();
          vscode.window.showInformationMessage(
            `Codebase MRI Scan Complete: ${summary.totalFiles} files, ${summary.totalSymbols} symbols indexed.`
          );
        }
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('forge-sentinel.reviewDiffs', async () => {
      const staged = patchManager.getAllStaged();
      if (staged.length === 0) {
        vscode.window.showInformationMessage('FORGE//SENTINEL: No patches currently staged.');
        return;
      }
      const items = staged.map((p) => ({
        label: p.filePath,
        description: `[${p.status.toUpperCase()}] ${p.hunks.length} hunk(s)`,
        detail: p.purpose,
        patchId: p.patchId,
      }));

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a staged patch to review before applying',
      });
      if (selected) {
        const patch = patchManager.getPatch(selected.patchId);
        if (patch) {
          const fileUri = vscode.Uri.file(patch.absolutePath);
          const tempProposed = vscode.Uri.parse(`untitled:${patch.filePath}.proposed`);
          const doc = await vscode.workspace.openTextDocument(tempProposed);
          const edit = new vscode.WorkspaceEdit();
          edit.replace(tempProposed, new vscode.Range(0, 0, doc.lineCount, 0), patch.proposedContent);
          await vscode.workspace.applyEdit(edit);
          await vscode.commands.executeCommand(
            'vscode.diff',
            fileUri,
            tempProposed,
            `Sentinel Review: ${patch.filePath}`
          );
        }
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('forge-sentinel.cancelTurn', () => {
      vscode.window.showInformationMessage('FORGE//SENTINEL: Turn cancellation requested.');
    })
  );

  mri.scan().catch((err) => console.warn('Background MRI scan warning:', err));
}

export async function deactivate(): Promise<void> {
  if (connectionManagerInstance) {
    connectionManagerInstance.dispose();
    connectionManagerInstance = null;
  }
  if (mcpServerInstance) {
    await mcpServerInstance.stop();
    mcpServerInstance = null;
  }
}

export { TrueForgeHarnessClient } from './agent/TrueForgeHarnessClient';
export { SentinelMcpServer } from './mcp/SentinelMcpServer';
export { CodebaseMri } from './context/CodebaseMri';
export { ContextAuction } from './context/ContextAuction';
export { PatchStagingManager } from './diff/PatchStagingManager';
export { ConnectionLifecycleManager } from './agent/ConnectionLifecycleManager';


