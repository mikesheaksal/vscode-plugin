import * as vscode from 'vscode';
import type { AlertRecord, AlertStoreState, AnsweredAlert } from '../core/alertStore';
import { EMPTY_STATE } from '../core/alertStore';

/**
 * Alerts awaiting a response, plus recently answered ones.
 *
 * This view, not the notification, is the honest record. A notification cannot
 * be closed programmatically and auto-hides if it has no buttons, so anything
 * the user misses has to be recoverable here (design section 7.3).
 */
export class AlertsTreeProvider implements vscode.TreeDataProvider<AlertsNode> {
  private state: AlertStoreState = EMPTY_STATE;
  private view: vscode.TreeView<AlertsNode> | undefined;

  private readonly emitter = new vscode.EventEmitter<AlertsNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  register(): vscode.Disposable {
    this.view = vscode.window.createTreeView('acmeAlerts.pending', {
      treeDataProvider: this,
      showCollapseAll: false,
    });
    return this.view;
  }

  update(state: AlertStoreState): void {
    this.state = state;
    this.emitter.fire(undefined);
    this.updateBadge(state.pending.length);
  }

  getTreeItem(node: AlertsNode): vscode.TreeItem {
    return node;
  }

  getChildren(node?: AlertsNode): AlertsNode[] {
    if (node === undefined) {
      const nodes: AlertsNode[] = this.state.pending.map(
        (entry) => new PendingAlertItem(entry.alert),
      );
      if (this.state.recent.length > 0) {
        nodes.push(new RecentFolder(this.state.recent.length));
      }
      return nodes;
    }
    if (node instanceof RecentFolder) {
      return this.state.recent.map((entry) => new AnsweredAlertItem(entry));
    }
    return [];
  }

  /**
   * The numeric badge VS Code draws on the Activity Bar icon. Set to undefined
   * rather than 0 to remove it: a badge reading "0" is worse than none.
   */
  private updateBadge(outstanding: number): void {
    if (!this.view) {
      return;
    }
    this.view.badge =
      outstanding > 0
        ? {
            value: outstanding,
            tooltip:
              outstanding === 1
                ? '1 alert awaiting your response'
                : `${outstanding} alerts awaiting your response`,
          }
        : undefined;
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

export type AlertsNode = PendingAlertItem | RecentFolder | AnsweredAlertItem;

export class PendingAlertItem extends vscode.TreeItem {
  constructor(readonly alert: AlertRecord) {
    super(alert.title || alert.message, vscode.TreeItemCollapsibleState.None);

    this.id = alert.alertId;
    if (alert.title) {
      this.description = alert.message;
    }
    this.tooltip = new vscode.MarkdownString(
      `**${escapeMarkdown(alert.title)}**\n\n${escapeMarkdown(alert.message)}`,
    );
    this.iconPath = severityIcon(alert.severity);

    // The button count drives which inline actions package.json shows, so an
    // alert with one button does not get a phantom second action.
    this.contextValue = `acmeAlert:${Math.min(alert.buttons.length, 2)}`;

    this.command = {
      command: 'acmeAlerts.showAlert',
      title: 'Show alert',
      arguments: [alert.alertId],
    };
  }
}

export class RecentFolder extends vscode.TreeItem {
  constructor(count: number) {
    super('Recent', vscode.TreeItemCollapsibleState.Collapsed);
    this.id = 'acmeAlerts.recent';
    this.description = String(count);
    this.contextValue = 'acmeAlertsRecent';
  }
}

export class AnsweredAlertItem extends vscode.TreeItem {
  constructor(entry: AnsweredAlert) {
    super(entry.alert.title || entry.alert.message, vscode.TreeItemCollapsibleState.None);
    this.id = `recent:${entry.alert.alertId}`;
    this.description =
      entry.outcome === 'revoked' ? 'withdrawn' : (entry.chosenLabel ?? 'answered');
    this.iconPath = new vscode.ThemeIcon(entry.outcome === 'revoked' ? 'circle-slash' : 'check');
    this.tooltip = new vscode.MarkdownString(
      `${escapeMarkdown(entry.alert.message)}\n\n_${entry.outcome} ${entry.answeredAt}_`,
    );
    this.contextValue = 'acmeAlertAnswered';
  }
}

function severityIcon(severity: AlertRecord['severity']): vscode.ThemeIcon {
  switch (severity) {
    case 'error':
      return new vscode.ThemeIcon('error', new vscode.ThemeColor('problemsErrorIcon.foreground'));
    case 'warning':
      return new vscode.ThemeIcon(
        'warning',
        new vscode.ThemeColor('problemsWarningIcon.foreground'),
      );
    default:
      return new vscode.ThemeIcon('info', new vscode.ThemeColor('problemsInfoIcon.foreground'));
  }
}

/** Alert text is server-supplied, and tooltips render markdown. */
function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|>]/g, '\\$&');
}
