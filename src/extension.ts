import * as vscode from 'vscode';
import { AlertService } from './alerts/alertService';
import { ApiClient } from './api/client';
import { checkClientVersion } from './clientInfo';
import { ConfigService } from './config';
import { reportIssue } from './diagnostics';
import { Logger } from './log';
import { MachineApplyService } from './machine/applyService';
import { MachineConfigService } from './machine/machineConfig';
import { StateController } from './state';
import { AlertsTreeProvider, PendingAlertItem } from './views/alertsTree';
import { MachineViewProvider } from './views/machineView';

export function activate(context: vscode.ExtensionContext): void {
  const log = new Logger('Acme Alerts');
  context.subscriptions.push(log);

  const version = context.extension.packageJSON.version as string;
  log.info(`Activating ${context.extension.id} ${version}`);

  const state = new StateController();
  const config = new ConfigService(context.secrets, log);
  context.subscriptions.push(state, config);

  const alertsTree = new AlertsTreeProvider();
  context.subscriptions.push(alertsTree, alertsTree.register());

  /**
   * Builds a client from whatever credentials currently resolve, or undefined
   * when the extension is not configured. Rebuilt per call rather than cached,
   * so a rotated token is picked up without restarting anything.
   */
  const clientFor = async (): Promise<ApiClient | undefined> => {
    const resolved = await config.resolve();
    if (resolved.kind !== 'ready') {
      return undefined;
    }
    return new ApiClient({
      baseUrl: resolved.credentials.serverUrl,
      token: resolved.credentials.token,
      clientId: resolved.credentials.clientId,
      clientVersion: version,
    });
  };

  const machineConfig = new MachineConfigService(context.globalState, log, clientFor);
  const machine = new MachineViewProvider(
    context.extensionUri,
    log,
    machineConfig,
    context.workspaceState,
  );
  context.subscriptions.push(
    machineConfig,
    machine,
    vscode.window.registerWebviewViewProvider(MachineViewProvider.viewType, machine, {
      // See MachineViewProvider: draft persistence replaces retaining the
      // webview, so we let VS Code reclaim it when hidden.
      webviewOptions: { retainContextWhenHidden: false },
    }),
  );

  const applyService = new MachineApplyService(machineConfig, log, clientFor);
  machine.onApply = (spec) => applyService.apply(spec);
  machine.onCancelChange = () => applyService.cancel();
  context.subscriptions.push(applyService);

  const alerts = new AlertService(context.globalState, log, alertsTree, config, clientFor, undefined, {
    // Completion of a configuration change arrives on the same stream as
    // alerts, so the alert service hands it on rather than owning it.
    onMachineConfigChanged: (event) => applyService.onConfigChanged(event),
  });
  context.subscriptions.push(alerts);

  context.subscriptions.push(
    vscode.commands.registerCommand('acmeAlerts.showMachine', () => machine.reveal()),
    vscode.commands.registerCommand('acmeAlerts.openInEditor', () => machine.openInEditor()),
    vscode.commands.registerCommand('acmeAlerts.showLog', () => log.show()),
    vscode.commands.registerCommand('acmeAlerts.reportIssue', () =>
      reportIssue(context, config, machineConfig, log),
    ),
    vscode.commands.registerCommand('acmeAlerts.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', '@ext:acme.acme-alerts'),
    ),
    vscode.commands.registerCommand('acmeAlerts.signIn', () => config.signIn()),
    vscode.commands.registerCommand('acmeAlerts.signOut', () => config.signOut()),
    vscode.commands.registerCommand('acmeAlerts.showAlert', (target: unknown) =>
      alerts.showAlert(alertIdOf(target)),
    ),
    vscode.commands.registerCommand('acmeAlerts.answerPrimary', (target: unknown) =>
      alerts.answerWith(alertIdOf(target), 0),
    ),
    vscode.commands.registerCommand('acmeAlerts.answerSecondary', (target: unknown) =>
      alerts.answerWith(alertIdOf(target), 1),
    ),
    vscode.commands.registerCommand('acmeAlerts.refresh', async () => {
      config.invalidate();
      machine.refresh();
      await restart(alerts, config, state, log);
    }),
  );

  // ConfigService already watches settings, secret storage and the credential
  // files, so this covers every way credentials can change.
  context.subscriptions.push(
    config.onDidChange(() => void restart(alerts, config, state, log)),
  );

  void restart(alerts, config, state, log).then(async () => {
    // Once per session, and never blocking activation.
    const client = await clientFor();
    if (client) {
      await checkClientVersion(client, version, log);
    }
  });
}

export function deactivate(): void {
  // Everything is registered through context.subscriptions.
}

/**
 * Points the alert service at the current credentials, starting or stopping it
 * as configuration comes and goes.
 */
async function restart(
  alerts: AlertService,
  config: ConfigService,
  state: StateController,
  log: Logger,
): Promise<void> {
  const resolved = await config.resolve();
  await state.set(resolved.kind);

  if (resolved.kind === 'ready') {
    await alerts.start();
    return;
  }

  alerts.stop();
  if (resolved.kind === 'no-client-id') {
    // Named explicitly because the fix is to create a file, and the user cannot
    // do that without knowing where it is looked for.
    log.warn(`No client id found at ${resolved.searchedPath}`);
  }
}

/**
 * Commands invoked from a tree item receive the item; invoked from the palette
 * or a test, they receive an id or nothing.
 */
function alertIdOf(target: unknown): string {
  if (target instanceof PendingAlertItem) {
    return target.alert.alertId;
  }
  return typeof target === 'string' ? target : '';
}
