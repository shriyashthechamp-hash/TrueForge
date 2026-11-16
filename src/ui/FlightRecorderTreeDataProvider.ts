import * as vscode from 'vscode';
import type { FlightRecorder } from '../flight-recorder/FlightRecorder.js';
import type { FlightRecorderEvent } from '../shared/types.js';

export type FlightTreeItemType = 'task' | 'event' | 'empty';

export class FlightRecorderTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly itemType: FlightTreeItemType,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly event?: FlightRecorderEvent
  ) {
    super(label, collapsibleState);

    if (itemType === 'empty') {
      this.iconPath = new vscode.ThemeIcon('history');
      this.description = 'Audit events and verification proofs will appear here';
      this.contextValue = 'empty';
    } else if (itemType === 'event' && event) {
      this.description = event.summary;
      const timeStr = event.timestamp ? new Date(event.timestamp).toLocaleTimeString() : '';
      this.tooltip = new vscode.MarkdownString(
        `**Event:** \`${event.type}\`\n\n` +
        `**Time:** ${timeStr}\n\n` +
        `**Summary:** ${event.summary}\n\n` +
        (event.details ? `\`\`\`json\n${JSON.stringify(event.details, null, 2).slice(0, 500)}\n\`\`\`` : '')
      );

      switch (event.type) {
        case 'turn_start':
          this.iconPath = new vscode.ThemeIcon('play-circle', new vscode.ThemeColor('charts.blue'));
          break;
        case 'tool_call':
          this.iconPath = new vscode.ThemeIcon('tools', new vscode.ThemeColor('charts.yellow'));
          break;
        case 'tool_result':
          this.iconPath = new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'));
          break;
        case 'patch_staged':
          this.iconPath = new vscode.ThemeIcon('diff-modified', new vscode.ThemeColor('editorWarning.foreground'));
          break;
        case 'patch_applied':
          this.iconPath = new vscode.ThemeIcon('check-all', new vscode.ThemeColor('testing.iconPassed'));
          break;
        case 'error':
          this.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
          break;
        case 'turn_done':
          this.iconPath = new vscode.ThemeIcon('verified', new vscode.ThemeColor('charts.green'));
          break;
        default:
          this.iconPath = new vscode.ThemeIcon('record');
          break;
      }
    }
  }
}

export class FlightRecorderTreeDataProvider implements vscode.TreeDataProvider<FlightRecorderTreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<FlightRecorderTreeItem | undefined | null | void> =
    new vscode.EventEmitter<FlightRecorderTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<FlightRecorderTreeItem | undefined | null | void> =
    this._onDidChangeTreeData.event;

  constructor(private readonly flightRecorder: FlightRecorder) {}

  public refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  public getTreeItem(element: FlightRecorderTreeItem): vscode.TreeItem {
    return element;
  }

  public getChildren(element?: FlightRecorderTreeItem): Thenable<FlightRecorderTreeItem[]> {
    if (!element) {
      const events = this.flightRecorder.getEvents();
      if (events.length === 0) {
        return Promise.resolve([
          new FlightRecorderTreeItem(
            'No flight events recorded yet',
            'empty',
            vscode.TreeItemCollapsibleState.None
          ),
        ]);
      }

      // Display events in reverse chronological order (newest on top)
      const reversed = [...events].reverse().slice(0, 30);
      return Promise.resolve(
        reversed.map((evt) => {
          const typeLabel = evt.type.replace('_', ' ').toUpperCase();
          return new FlightRecorderTreeItem(
            `[${typeLabel}] ${new Date(evt.timestamp).toLocaleTimeString()}`,
            'event',
            vscode.TreeItemCollapsibleState.None,
            evt
          );
        })
      );
    }

    return Promise.resolve([]);
  }
}

