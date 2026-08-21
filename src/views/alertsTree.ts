import * as vscode from 'vscode';

/**
 * Alerts pending a response, plus recently answered ones.
 *
 * Phase 1 is the empty shell: the tree exists, is registered, and owns the
 * Activity Bar badge. Alerts arrive in Phase 4.
 */
export class AlertsTreeProvider implements vscode.TreeDataProvider<AlertItem> {
  private readonly emitter = new vscode.EventEmitter<AlertItem | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  private view: vscode.TreeView<AlertItem> | undefined;

  register(): vscode.Disposable {
    this.view = vscode.window.createTreeView('acmeAlerts.pending', {
      treeDataProvider: this,
      showCollapseAll: false,
    });
    return this.view;
  }

  getTreeItem(element: AlertItem): vscode.TreeItem {
    return element;
  }

  getChildren(): AlertItem[] {
    return [];
  }

  refresh(): void {
    this.emitter.fire(undefined);
    this.updateBadge(0);
  }

  /**
   * The numeric badge VS Code draws on the Activity Bar icon. Setting it to
   * undefined rather than 0 removes it; a badge reading "0" is worse than none.
   */
  updateBadge(outstanding: number): void {
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

export class AlertItem extends vscode.TreeItem {}
