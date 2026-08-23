import * as vscode from 'vscode';
import type { ApiClient } from './api/client';
import { isOutdated } from './core/version';
import type { Logger } from './log';

/**
 * Checks the running version against the server's minimum, once per session.
 *
 * The `.vsix` distribution model means nothing auto-updates, so an install can
 * sit in the field indefinitely. Without this, an old client fails in whatever
 * obscure way the contract drifted; with it, the user is told plainly.
 */
export async function checkClientVersion(
  client: ApiClient,
  currentVersion: string,
  log: Logger,
): Promise<void> {
  try {
    const info = await client.getClientInfo();
    log.info(
      `Connected as ${info.clientId}${info.displayName === '' ? '' : ` (${info.displayName})`}`,
    );

    if (!isOutdated(currentVersion, info.minClientVersion)) {
      return;
    }

    log.warn(
      `This extension is ${currentVersion}; the server requires ${info.minClientVersion} or newer.`,
    );
    // Actionable rather than fatal: an outdated client may still work for most
    // things, and there is no update button to press — somebody has to hand
    // over a new .vsix.
    await vscode.window.showWarningMessage(
      `Acme Alerts ${currentVersion} is older than the ${info.minClientVersion} this server expects. Ask for an updated .vsix — some features may not work correctly.`,
      'Show Log',
    );
  } catch (error) {
    // Never blocks startup: a failed check is a worse reason to be unusable
    // than an out-of-date client.
    log.debug('Client version check failed', error);
  }
}
