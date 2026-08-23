import * as vscode from 'vscode';
import type { ConfigService } from './config';
import type { Logger } from './log';
import type { MachineConfigService } from './machine/machineConfig';

/**
 * The Report Issue command.
 *
 * The extension sends no telemetry, so the only way a problem reaches whoever
 * can fix it is the user pasting something. This assembles that something:
 * enough to diagnose, nothing that identifies a person, and no secrets — the
 * log lines it includes were redacted when they were written, and the
 * credential *paths* are reported rather than the credentials.
 */
export async function reportIssue(
  context: vscode.ExtensionContext,
  config: ConfigService,
  machineConfig: MachineConfigService,
  log: Logger,
): Promise<void> {
  const credentials = await config.resolve();

  const lines = [
    '### Acme Alerts diagnostics',
    '',
    `Extension: ${context.extension.id} ${context.extension.packageJSON.version as string}`,
    `VS Code:   ${vscode.version}`,
    `Platform:  ${process.platform} ${process.arch}`,
    `Node:      ${process.versions.node}`,
    '',
    `Credentials: ${credentials.kind}`,
    ...(credentials.kind === 'ready'
      ? [`Token source: ${credentials.credentials.tokenSource}`]
      : []),
    `Client id file: ${config.clientIdFilePath}`,
    `Token file:     ${config.tokenFilePath}`,
    '',
    `Machine config: ${describeMachine(machineConfig)}`,
    '',
    '### Recent log',
    '',
    '```',
    ...log.recent(),
    '```',
  ];

  const report = lines.join('\n');
  await vscode.env.clipboard.writeText(report);
  log.info('Diagnostics copied to the clipboard');

  const show = 'Show Log';
  const picked = await vscode.window.showInformationMessage(
    'Diagnostics copied to the clipboard. Check it before sharing — it contains file paths.',
    show,
  );
  if (picked === show) {
    log.show();
  }
}

function describeMachine(service: MachineConfigService): string {
  const state = service.current;
  switch (state.kind) {
    case 'ready':
      return `${state.config.version}${state.stale ? ' (stale)' : ''}${
        service.pendingChange ? `, applying ${service.pendingChange.changeId}` : ''
      }`;
    case 'error':
      return `error: ${state.message}`;
    default:
      return state.kind;
  }
}
