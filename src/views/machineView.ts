import * as vscode from 'vscode';
import { Logger } from '../log';

/**
 * The machine configuration form, rendered inside the sidebar.
 *
 * Phase 1 renders a themed placeholder. The webview plumbing is real, though —
 * CSP, nonce, restricted resource roots, and the message channel — because
 * getting those right later, around working form code, is harder than starting
 * with them.
 *
 * `retainContextWhenHidden` is deliberately off: the view is torn down whenever
 * it is collapsed or another container is selected, and Phase 6 restores its
 * draft on `resolveWebviewView` rather than pinning the webview in memory for
 * the session (design §8.1).
 */
export class MachineViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'acmeAlerts.machine';

  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly log: Logger,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;

    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    view.webview.html = this.html(view.webview);

    view.webview.onDidReceiveMessage((message: unknown) => {
      this.log.debug('machine view message', message);
    });

    view.onDidDispose(() => {
      this.view = undefined;
    });

    this.log.debug('machine view resolved');
  }

  /** Reveals the view, resolving it first if it is not currently visible. */
  async reveal(): Promise<void> {
    if (this.view) {
      this.view.show(true);
      return;
    }
    await vscode.commands.executeCommand('acmeAlerts.machine.focus');
  }

  refresh(): void {
    if (this.view) {
      this.view.webview.html = this.html(this.view.webview);
    }
  }

  private html(webview: vscode.Webview): string {
    const nonce = makeNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">
  body {
    padding: 12px;
    color: var(--vscode-sideBar-foreground, var(--vscode-foreground));
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    line-height: 1.5;
  }
  h2 {
    font-size: 1em;
    font-weight: 600;
    margin: 0 0 8px;
  }
  p {
    margin: 0 0 8px;
    color: var(--vscode-descriptionForeground);
  }
</style>
</head>
<body>
  <h2>Machine</h2>
  <p>Not connected yet.</p>
  <p>The configuration form arrives in Phase 6.</p>
</body>
</html>`;
  }
}

/**
 * 128 bits of randomness for the CSP nonce, so an injected inline script cannot
 * guess it. Math.random would not be good enough here.
 */
function makeNonce(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
