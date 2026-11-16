import * as vscode from 'vscode';
import * as path from 'node:path';
import type { PatchStagingManager } from '../diff/PatchStagingManager.js';
import type { StagedFilePatch, DiffHunk } from '../shared/types.js';

export type PatchTreeItemType = 'patch' | 'hunk' | 'empty';

export class StagedPatchTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly itemType: PatchTreeItemType,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly patch?: StagedFilePatch,
    public readonly hunk?: DiffHunk
  ) {
    super(label, collapsibleState);

    if (itemType === 'empty') {
      this.iconPath = new vscode.ThemeIcon('info');
      this.description = 'Changes proposed by Sentinel will appear here for hunk review';
      this.contextValue = 'empty';
    } else if (itemType === 'patch' && patch) {
      const isApplied = patch.status === 'applied';
      const isRejected = patch.status === 'rejected';
      this.iconPath = isApplied
        ? new vscode.ThemeIcon('check', new vscode.ThemeColor('testing.iconPassed'))
        : isRejected
        ? new vscode.ThemeIcon('x', new vscode.ThemeColor('testing.iconFailed'))
        : new vscode.ThemeIcon('git-pull-request-draft', new vscode.ThemeColor('editorWarning.foreground'));

      this.description = `[${patch.status.toUpperCase()}] ${patch.hunks.length} hunk(s)`;
      this.tooltip = new vscode.MarkdownString(
        `**File:** \`${patch.filePath}\`\n\n` +
        `**Status:** ${patch.status.toUpperCase()}\n\n` +
        `**Purpose:** ${patch.purpose}\n\n` +
        `**Risk Level:** ${patch.riskLevel.toUpperCase()}\n\n` +
        `*Click to review side-by-side diff in editor*`
      );
      this.contextValue = 'stagedPatch';
      this.command = {
        command: 'forge-sentinel.openPatchDiff',
        title: 'Review Staged Patch Diff',
        arguments: [patch.patchId],
      };
    } else if (itemType === 'hunk' && hunk && patch) {
      const isAccepted = hunk.accepted !== false;
      this.iconPath = isAccepted
        ? new vscode.ThemeIcon('diff-added', new vscode.ThemeColor('charts.green'))
        : new vscode.ThemeIcon('diff-removed', new vscode.ThemeColor('charts.red'));
      this.description = isAccepted ? 'Accepted' : 'Discarded';
      this.tooltip = `Lines ${hunk.newStart}-${hunk.newStart + hunk.newLines}: ${hunk.header}`;
      this.contextValue = 'stagedHunk';
    }
  }
}

export class StagedPatchesTreeDataProvider implements vscode.TreeDataProvider<StagedPatchTreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<StagedPatchTreeItem | undefined | null | void> =
    new vscode.EventEmitter<StagedPatchTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<StagedPatchTreeItem | undefined | null | void> =
    this._onDidChangeTreeData.event;

  constructor(private readonly patchManager: PatchStagingManager) {}

  public refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  public getTreeItem(element: StagedPatchTreeItem): vscode.TreeItem {
    return element;
  }

  public getChildren(element?: StagedPatchTreeItem): Thenable<StagedPatchTreeItem[]> {
    if (!element) {
      const allStaged = this.patchManager.getAllStaged();
      if (allStaged.length === 0) {
        return Promise.resolve([
          new StagedPatchTreeItem(
            'No patches currently staged',
            'empty',
            vscode.TreeItemCollapsibleState.None
          ),
        ]);
      }

      return Promise.resolve(
        allStaged.map((patch) => {
          const hasMultipleHunks = patch.hunks.length > 1;
          return new StagedPatchTreeItem(
            path.basename(patch.filePath),
            'patch',
            hasMultipleHunks
              ? vscode.TreeItemCollapsibleState.Collapsed
              : vscode.TreeItemCollapsibleState.None,
            patch
          );
        })
      );
    }

    if (element.itemType === 'patch' && element.patch) {
      const patch = element.patch;
      return Promise.resolve(
        patch.hunks.map(
          (hunk, index) =>
            new StagedPatchTreeItem(
              `Hunk #${index + 1} (lines ${hunk.newStart}-${hunk.newStart + hunk.newLines})`,
              'hunk',
              vscode.TreeItemCollapsibleState.None,
              patch,
              hunk
            )
        )
      );
    }

    return Promise.resolve([]);
  }
}

