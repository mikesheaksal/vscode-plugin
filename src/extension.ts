import * as vscode from 'vscode';
import { ConfigService } from './config';
import { Logger } from './log';
import { StateController } from './state';
import { AlertsTreeProvider } from './views/alertsTree';
import { MachineViewProvider } from './views/machineView';

export function activate(context: vscode.ExtensionContext): void {
  const log = new Logger('Acme Alerts');
  context.subscriptions.push(log);
  log.info(`Activating ${context.extension.id} ${context.extension.packageJSON.version as string}`);

  const state = new StateController();
  const config = new ConfigService(context.secrets, log);
  context.subscriptions.push(state, config);

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
      vscode.commands.executeCommand('workbench.action.openSettings', '@ext:acme.acme-alerts'),
    ),
    vscode.commands.registerCommand('acmeAlerts.signIn', () => config.signIn()),
    vscode.commands.registerCommand('acmeAlerts.signOut', () => config.signOut()),
    vscode.commands.registerCommand('acmeAlerts.refresh', async () => {
      config.invalidate();
      alerts.refresh();
      machine.refresh();
      await syncState(config, state, log);
    }),
  );

  // ConfigService already watches settings, secret storage and the credential
  // files, so this covers every way credentials can change.
  context.subscriptions.push(config.onDidChange(() => void syncState(config, state, log)));

  void syncState(config, state, log);
}

export function deactivate(): void {
  // Everything is registered through context.subscriptions.
}

async function syncState(
  config: ConfigService,
  state: StateController,
  log: Logger,
): Promise<void> {
  const resolved = await config.resolve();
  await state.set(resolved.kind);
  if (resolved.kind === 'no-client-id') {
    // Named explicitly because the fix is to create a file, and the user
    // cannot do that without knowing where it is looked for.
    log.warn(`No client id found at ${resolved.searchedPath}`);
  }
}
