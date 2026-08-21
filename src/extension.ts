import * as vscode from 'vscode';
import { Logger } from './log';
import { StateController } from './state';
import { AlertsTreeProvider } from './views/alertsTree';
import { MachineViewProvider } from './views/machineView';

const CONFIG_SECTION = 'acmeAlerts';

export function activate(context: vscode.ExtensionContext): void {
  const log = new Logger('Acme Alerts');
  context.subscriptions.push(log);
  log.info(`Activating ${context.extension.id} ${context.extension.packageJSON.version as string}`);

  const state = new StateController();
  context.subscriptions.push(state);

  const alerts = new AlertsTreeProvider();
  context.subscriptions.push(alerts, alerts.register());

  const machine = new MachineViewProvider(context.extensionUri, log);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(MachineViewProvider.viewType, machine, {
      // See MachineViewProvider: draft persistence replaces retaining the
      // webview, so we let VS Code reclaim it when hidden.
      webviewOptions: { retainContextWhenHidden: false },
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('acmeAlerts.showMachine', () => machine.reveal()),
    vscode.commands.registerCommand('acmeAlerts.showLog', () => log.show()),
    vscode.commands.registerCommand('acmeAlerts.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', `@ext:acme.acme-alerts`),
    ),
    vscode.commands.registerCommand('acmeAlerts.signIn', () => notImplemented('Sign in', log)),
    vscode.commands.registerCommand('acmeAlerts.refresh', () => {
      alerts.refresh();
      machine.refresh();
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(CONFIG_SECTION)) {
        log.debug('configuration changed');
        void applyState(state, log);
      }
    }),
  );

  void applyState(state, log);
}

export function deactivate(): void {
  // Everything is registered through context.subscriptions.
}

/**
 * Phase 1 knows one thing about configuration: whether a server URL is set.
 * Token and client-id resolution — and the states that need a server round trip
 * to establish — arrive in Phase 2.
 */
async function applyState(state: StateController, log: Logger): Promise<void> {
  const serverUrl = vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>('serverUrl', '');
  const next = serverUrl.trim() === '' ? 'unconfigured' : 'ready';
  await state.set(next);
  await state.sync();
  log.info(`State: ${next}`);
}

function notImplemented(what: string, log: Logger): void {
  log.warn(`${what} is not implemented yet (Phase 2).`);
  void vscode.window.showInformationMessage(`${what} arrives in Phase 2.`);
}
