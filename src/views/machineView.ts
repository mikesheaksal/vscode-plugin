import * as vscode from 'vscode';
import {
  EMPTY_DRAFT,
  validate,
  type FieldErrors,
  type FormDraft,
  type MachineSpec,
} from '../core/machineForm';
import type { Logger } from '../log';
import type { MachineConfigService, MachineConfigState } from '../machine/machineConfig';

const DRAFT_KEY = 'acmeAlerts.machineDraft';

/**
 * The machine configuration form, rendered inside the sidebar.
 *
 * `retainContextWhenHidden` is deliberately off: the view is torn down whenever
 * it is collapsed or another Activity Bar container is selected. The draft is
 * persisted on every change and replayed on resolve, which covers that and the
 * window reload it would need anyway — one state mechanism rather than two
 * (design section 8.1).
 */
export class MachineViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'acmeAlerts.machine';

  private view: vscode.WebviewView | undefined;
  private panel: vscode.WebviewPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  /** Set by Phase 6b to actually apply a change. */
  onApply: ((spec: MachineSpec) => Promise<void>) | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly log: Logger,
    private readonly config: MachineConfigService,
    private readonly workspaceState: vscode.Memento,
  ) {
    this.disposables.push(this.config.onDidChange(() => this.post()));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;

    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    view.webview.html = this.html(view.webview);

    view.webview.onDidReceiveMessage(
      (message: unknown) => void this.onMessage(message),
      undefined,
      this.disposables,
    );

    view.onDidChangeVisibility(
      () => {
        if (view.visible) {
          void this.config.ensureFresh();
        }
      },
      undefined,
      this.disposables,
    );

    view.onDidDispose(() => {
      this.view = undefined;
    });

    void this.config.ensureFresh();
  }

  /**
   * Reopens the same form as a full-width editor panel.
   *
   * The panel and the sidebar view share one HTML generator, one message
   * handler and one draft; only the shell differs. With five short fields the
   * sidebar is adequate, so this is an escape hatch rather than load-bearing.
   */
  openInEditor(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      'acmeAlerts.machinePanel',
      'Machine',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
      },
    );
    this.panel.webview.html = this.html(this.panel.webview);
    this.panel.webview.onDidReceiveMessage((message: unknown) => void this.onMessage(message));
    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });
    void this.config.ensureFresh();
  }

  async reveal(): Promise<void> {
    if (this.view) {
      this.view.show(true);
      return;
    }
    await vscode.commands.executeCommand('acmeAlerts.machine.focus');
  }

  refresh(): void {
    void this.config.refresh();
  }

  /** Locks the form while a change is being applied (Phase 6b). */
  setBusy(value: boolean): void {
    this.broadcast({ type: 'busy', value });
  }

  reportResult(ok: boolean, error?: string, fieldErrors?: FieldErrors): void {
    this.broadcast({ type: 'result', ok, error, fieldErrors });
  }

  /** Both surfaces show the same form, so both get every update. */
  private broadcast(message: unknown): void {
    void this.view?.webview.postMessage(message);
    void this.panel?.webview.postMessage(message);
  }

  dispose(): void {
    this.panel?.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private async onMessage(message: unknown): Promise<void> {
    if (typeof message !== 'object' || message === null) {
      return;
    }
    const payload = message as { type?: string; draft?: FormDraft; spec?: MachineSpec };

    switch (payload.type) {
      case 'ready':
        this.post();
        break;
      case 'refresh':
        await this.config.refresh();
        break;
      case 'draft':
        if (payload.draft) {
          await this.workspaceState.update(DRAFT_KEY, payload.draft);
        }
        break;
      case 'apply':
        await this.apply(payload.spec);
        break;
      default:
        this.log.debug(`Unhandled webview message: ${String(payload.type)}`);
    }
  }

  private async apply(spec: MachineSpec | undefined): Promise<void> {
    const state = this.config.current;
    if (!spec || state.kind !== 'ready') {
      return;
    }

    // Validated again here: the webview decides what to *show*, never what to
    // *send*.
    const draft = this.workspaceState.get<FormDraft>(DRAFT_KEY) ?? EMPTY_DRAFT;
    const checked = validate(draft, state.config.gpuTypes, state.config.limits);
    if (!checked.spec) {
      this.reportResult(false, 'Please correct the highlighted fields.', checked.errors);
      return;
    }

    if (!this.onApply) {
      // Phase 6b wires this up. Until then, say so rather than appearing to
      // succeed.
      this.reportResult(false, 'Applying changes arrives in the next phase.');
      return;
    }
    await this.onApply(checked.spec);
  }

  /** Sends the current state and any saved draft to the webview. */
  private post(): void {
    this.broadcast({ type: 'init', ...describe(this.config.current, this.savedDraft()) });
  }

  private savedDraft(): FormDraft | undefined {
    return this.workspaceState.get<FormDraft>(DRAFT_KEY);
  }

  private html(webview: vscode.Webview): string {
    const nonce = makeNonce();
    const script = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'form.js'),
    );
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'form.css'));

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style.toString()}">
<title>Machine</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${script.toString()}"></script>
</body>
</html>`;
  }
}

/** Maps the service's state onto the message shape the webview expects. */
function describe(
  state: MachineConfigState,
  draft: FormDraft | undefined,
): Record<string, unknown> {
  switch (state.kind) {
    case 'loading':
      return { status: 'loading' };
    case 'unconfigured':
      return { status: 'unconfigured' };
    case 'error':
      return { status: 'error', message: state.message };
    case 'ready':
      return {
        status: 'ready',
        stale: state.stale,
        gpuTypes: state.config.gpuTypes,
        limits: state.config.limits,
        current: state.config.current,
        draft,
        // A change already in flight means the form is read-only until it
        // finishes, so a second change cannot be queued on top of the first.
        readOnly: state.config.pendingChangeId !== undefined,
      };
  }
}

/**
 * 128 bits of randomness for the CSP nonce, so an injected inline script cannot
 * guess it. Math.random would not be good enough here.
 */
function makeNonce(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
