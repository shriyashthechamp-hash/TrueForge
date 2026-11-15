import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as vscode from 'vscode';
import type { TrueForgeHarnessClient } from '../agent/TrueForgeHarnessClient.js';
import type { ContextAuction } from '../context/ContextAuction.js';
import type { PatchStagingManager } from '../diff/PatchStagingManager.js';
import type { FlightRecorder } from '../flight-recorder/FlightRecorder.js';

export class InlineEditController {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly patchManager: PatchStagingManager,
    private readonly auction: ContextAuction,
    private readonly trueforge: TrueForgeHarnessClient,
    private readonly flightRecorder: FlightRecorder
  ) {}

  public async triggerInlineEdit(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('FORGE//SENTINEL: No active editor found for inline edit.');
      return;
    }

    const document = editor.document;
    const selection = editor.selection;
    const selectedText = document.getText(selection.isEmpty ? undefined : selection);
    const relPath = vscode.workspace.asRelativePath(document.uri);

    const instruction = await vscode.window.showInputBox({
      title: 'FORGE//SENTINEL — Inline Surgical Edit',
      prompt: `Editing "${path.basename(relPath)}" ${selection.isEmpty ? '(whole file)' : `(lines ${selection.start.line + 1}-${selection.end.line + 1})`}`,
      placeHolder: "e.g. Treat the values 'off' and 'n' as false as well, case-insensitively...",
      ignoreFocusOut: true,
    });

    if (!instruction || instruction.trim() === '') {
      return;
    }

    this.flightRecorder.startTask(`inline_${Date.now()}`, instruction);

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'FORGE//SENTINEL: Synthesizing surgical edit...',
        cancellable: true,
      },
      async (progress, token) => {
        const abortController = new AbortController();
        token.onCancellationRequested(() => {
          abortController.abort();
        });

        progress.report({ message: 'Running Context Auction...' });
        const { receipt, contextBundle } = await this.auction.runAuction(
          `${instruction} @file:${relPath}`,
          8000
        );

        this.flightRecorder.record('tool_result', 'Context Auction executed', {
          selectedFiles: receipt.selectedFiles.map((f) => f.filePath),
          tokens: receipt.totalTokensUsed,
        });

        progress.report({ message: 'Invoking TrueForge Agent...' });

        let proposedCode = '';
        try {
          const sessionId = await this.trueforge.createSession({
            instructions: `You are performing an inline surgical edit on file: ${relPath}.
Make ONLY the minimum necessary change to completely satisfy the instruction.
Propose the exact modified file content using the propose_file_edit tool.`,
          });

          const prompt = `INLINE EDIT REQUEST:
Target File: ${relPath}
User Instruction: ${instruction}

Selected Code to Modify:
\`\`\`
${selectedText || document.getText()}
\`\`\`

Surrounding Workspace Context:
${contextBundle}

Call propose_file_edit with the exact complete proposed content for ${relPath}.`;

          await this.trueforge.runTurn(
            sessionId,
            prompt,
            {
              onTokenDelta: (delta) => {
                progress.report({ message: `Streaming proposal...` });
              },
            },
            abortController.signal
          );
        } catch (err: any) {
          if (err.name === 'AbortError') {
            vscode.window.showInformationMessage('FORGE//SENTINEL: Inline edit cancelled.');
            return;
          }
          vscode.window.showErrorMessage(`FORGE//SENTINEL Error: ${err.message}`);
          return;
        }

        const stagedList = this.patchManager.getAllStaged();
        const latestPatch = stagedList[stagedList.length - 1];

        if (!latestPatch) {
          vscode.window.showInformationMessage('FORGE//SENTINEL: No patch was proposed by the agent.');
          return;
        }

        const tempDir = path.join(os.tmpdir(), 'forge_sentinel_diffs');
        await fs.mkdir(tempDir, { recursive: true });
        const tempProposedPath = path.join(tempDir, `proposed_${path.basename(relPath)}`);
        await fs.writeFile(tempProposedPath, latestPatch.proposedContent, 'utf8');

        const tempUri = vscode.Uri.file(tempProposedPath);
        await vscode.commands.executeCommand(
          'vscode.diff',
          document.uri,
          tempUri,
          `Sentinel Review: ${path.basename(relPath)} (Proposed Edit)`
        );

        const choice = await vscode.window.showInformationMessage(
          `FORGE//SENTINEL: Surgical patch ready for "${path.basename(relPath)}" (${latestPatch.hunks.length} hunk(s)).`,
          { modal: false },
          'Accept Change',
          'Reject Change'
        );

        if (choice === 'Accept Change') {
          await this.applyStagedPatchToWorkspace(latestPatch.patchId, document);
          vscode.window.showInformationMessage(`FORGE//SENTINEL: Applied changes to "${path.basename(relPath)}". You can undo via Cmd+Z.`);
        } else {
          this.patchManager.setPatchDecision(latestPatch.patchId, 'reject');
          vscode.window.showInformationMessage('FORGE//SENTINEL: Proposed change rejected.');
        }
      }
    );
  }

  public async applyStagedPatchToWorkspace(patchId: string, document: vscode.TextDocument): Promise<void> {
    const patch = this.patchManager.getPatch(patchId);
    if (!patch) return;

    const fullRange = new vscode.Range(
      document.positionAt(0),
      document.positionAt(document.getText().length)
    );

    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, fullRange, patch.proposedContent);

    const applied = await vscode.workspace.applyEdit(edit);
    if (applied) {
      patch.status = 'applied';
      this.flightRecorder.record('patch_applied', `Applied patch ${patchId} to ${patch.filePath}`, {
        patchId,
        filePath: patch.filePath,
      });
      await document.save();
    }
  }
}
