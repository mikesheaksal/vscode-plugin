import * as vscode from 'vscode';
import { AlertOutcome, type Alert } from '../gen/acme/alerts/v1/alerts_pb';
import { Severity } from '../gen/acme/alerts/v1/alerts_pb';
import type { ApiClient } from '../api/client';
import { ApiError, NetworkError } from '../api/errors';
import type { ConfigService } from '../config';
import {
  EMPTY_STATE,
  announcementFor,
  findPending,
  markAnswered,
  markNotified,
  receive,
  reconcile,
  unnotified,
  type AlertRecord,
  type AlertSeverity,
  type AlertStoreState,
} from '../core/alertStore';
import type { Logger } from '../log';
import type { AlertsTreeProvider } from '../views/alertsTree';

/**
 * The notification surface, injectable so the alert flow can be driven end to
 * end in tests. A test cannot click a real VS Code notification, and the logic
 * worth testing is what gets shown and what the answer does — not the toast.
 */
export interface Notifier {
  show(
    severity: AlertSeverity,
    text: string,
    options: vscode.MessageOptions,
    buttons: string[],
  ): Thenable<string | undefined>;
}

export const vscodeNotifier: Notifier = {
  show(severity, text, options, buttons) {
    switch (severity) {
      case 'error':
        return vscode.window.showErrorMessage(text, options, ...buttons);
      case 'warning':
        return vscode.window.showWarningMessage(text, options, ...buttons);
      default:
        return vscode.window.showInformationMessage(text, options, ...buttons);
    }
  },
};

const STATE_KEY = 'acmeAlerts.alerts';
const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;

export interface AlertServiceOptions {
  /** How long each poll asks the server to block for. */
  pollWaitSeconds?: number;
  /**
   * Minimum gap after a poll that came back with alerts.
   *
   * ListPendingAlerts returns immediately when anything is already pending, so
   * without a floor the loop spins: answer nothing, and the client re-polls as
   * fast as the network allows for as long as the alert is outstanding.
   */
  minIntervalMs?: number;
}

/**
 * Receives alerts, shows them, and posts the user's answer back.
 *
 * Phase 4 polls with `ListPendingAlerts`; Phase 5 replaces the loop with the
 * event stream and keeps this class's responsibilities unchanged. The polling
 * path stays either way as the fallback for proxies that buffer the stream.
 */
export class AlertService implements vscode.Disposable {
  private state: AlertStoreState;
  private running = false;
  private backoffMs = MIN_BACKOFF_MS;
  private abort: AbortController | undefined;
  private readonly pollWaitSeconds: number;
  private readonly minIntervalMs: number;
  /** Set after a 401 so a bad token produces one prompt, not a prompt per poll. */
  private reauthAttempted = false;

  constructor(
    private readonly memento: vscode.Memento,
    private readonly log: Logger,
    private readonly tree: AlertsTreeProvider,
    private readonly config: ConfigService,
    private readonly clientFor: () => Promise<ApiClient | undefined>,
    private readonly notifier: Notifier = vscodeNotifier,
    options: AlertServiceOptions = {},
  ) {
    this.state = this.memento.get<AlertStoreState>(STATE_KEY) ?? EMPTY_STATE;
    this.pollWaitSeconds = options.pollWaitSeconds ?? 30;
    this.minIntervalMs = options.minIntervalMs ?? 5_000;
  }

  /**
   * Restores persisted alerts and starts polling.
   *
   * Restored alerts are deliberately not re-notified one by one: replaying
   * six-day-old notifications at every window open is how users learn to click
   * things away without reading them (design section 7.4).
   */
  async start(): Promise<void> {
    this.tree.update(this.state);

    const outstanding = this.state.pending.length;
    if (outstanding > 0) {
      this.log.info(`Restored ${outstanding} outstanding alert(s)`);
      const restored = unnotified(this.state);
      if (restored.length > 0) {
        this.state = markNotified(
          this.state,
          restored.map((alert) => alert.alertId),
        );
        await this.persist();
      }
      void this.showSummary(outstanding);
    }

    if (!this.running) {
      this.running = true;
      void this.poll();
    }
  }

  stop(): void {
    this.running = false;
    this.abort?.abort();
  }

  /** Re-presents an alert as a modal, for one selected in the view. */
  async showAlert(alertId: string): Promise<void> {
    const alert = findPending(this.state, alertId);
    if (!alert) {
      void vscode.window.showInformationMessage('That alert is no longer active.');
      return;
    }
    await this.present(alert, true);
  }

  /** Answers with the alert's first or second button, from an inline action. */
  async answerWith(alertId: string, index: 0 | 1): Promise<void> {
    const alert = findPending(this.state, alertId);
    const button = alert?.buttons[index];
    if (!alert || !button) {
      void vscode.window.showInformationMessage('That alert is no longer active.');
      return;
    }
    await this.respond(alert, button.buttonId, button.label);
  }

  dispose(): void {
    this.stop();
  }

  // -------------------------------------------------------------------------
  // Polling
  // -------------------------------------------------------------------------

  private async poll(): Promise<void> {
    while (this.running) {
      const client = await this.clientFor();
      if (!client) {
        // Not configured yet. ConfigService fires onDidChange when that
        // changes, and the extension restarts us.
        this.running = false;
        return;
      }

      this.abort = new AbortController();
      try {
        const response = await client.listPendingAlerts(this.pollWaitSeconds, this.abort.signal);
        await this.ingest(response.alerts);
        this.backoffMs = MIN_BACKOFF_MS;
        this.reauthAttempted = false;

        // The server answers instantly while anything is outstanding, so pace
        // the loop rather than re-asking as fast as the network allows.
        if (response.alerts.length > 0) {
          await delay(this.minIntervalMs);
        }
      } catch (error) {
        if (!this.running) {
          return;
        }
        const stop = await this.handlePollError(error);
        if (stop) {
          this.running = false;
          return;
        }
        await delay(this.backoffMs);
        this.backoffMs = nextBackoff(this.backoffMs);
      }
    }
  }

  /** Returns true when polling should stop rather than back off. */
  private async handlePollError(error: unknown): Promise<boolean> {
    if (error instanceof NetworkError) {
      this.log.debug(`Poll failed: ${error.message}`);
      return false;
    }
    if (!(error instanceof ApiError)) {
      this.log.error('Poll failed', error);
      return false;
    }

    switch (error.disposition) {
      case 'reauthenticate': {
        if (this.reauthAttempted) {
          this.log.error('Token rejected twice; stopping.');
          void this.promptSignIn();
          return true;
        }
        // The token file may have been refreshed by an external tool since we
        // last read it, so re-resolve once before giving up.
        this.reauthAttempted = true;
        this.log.warn('Token rejected; re-resolving credentials and retrying once.');
        this.config.invalidate();
        return false;
      }
      case 'not-authorized': {
        // Valid token, wrong client. Retrying and re-prompting both waste the
        // user's time: this is a provisioning error.
        this.log.error(error.message);
        void vscode.window.showErrorMessage(`Acme Alerts: ${error.message}`);
        return true;
      }
      case 'retry': {
        if (error.retryAfterSeconds !== undefined) {
          this.backoffMs = Math.max(this.backoffMs, error.retryAfterSeconds * 1000);
        }
        this.log.debug(`Poll failed (${error.code}): ${error.message}`);
        return false;
      }
      default: {
        this.log.warn(`Poll failed (${error.code}): ${error.message}`);
        return false;
      }
    }
  }

  private async ingest(alerts: Alert[]): Promise<void> {
    const records = alerts.map(toRecord);

    const received = receive(this.state, records);
    // The server is authoritative about what is still live, so anything held
    // locally but absent here was answered elsewhere or withdrawn.
    this.state = reconcile(
      received.state,
      records.map((record) => record.alertId),
    );

    if (received.fresh.length > 0) {
      this.log.info(`Received ${received.fresh.length} new alert(s)`);
    }

    const announcement = announcementFor(received.fresh, this.state.pending.length);
    if (announcement.kind !== 'none') {
      this.state = markNotified(
        this.state,
        received.fresh.map((alert) => alert.alertId),
      );
    }

    await this.persist();

    if (announcement.kind === 'individual') {
      for (const alert of announcement.alerts) {
        void this.present(alert, alert.modal);
      }
    } else if (announcement.kind === 'summary') {
      void this.showSummary(announcement.outstanding);
    }
  }

  // -------------------------------------------------------------------------
  // Presentation
  // -------------------------------------------------------------------------

  /**
   * Shows one alert as a notification.
   *
   * Every alert gets at least one button: a notification without buttons
   * auto-hides after a few seconds, so a button-less alert would silently
   * vanish unanswered (design section 7.2).
   */
  private async present(alert: AlertRecord, modal: boolean): Promise<void> {
    const buttons = alert.buttons.length > 0 ? alert.buttons.slice(0, 2) : FALLBACK_BUTTONS;
    const labels = buttons.map((button) => button.label);
    const options: vscode.MessageOptions = alert.title
      ? { modal, detail: alert.message }
      : { modal };
    const text = alert.title || alert.message;

    const picked = await this.notifier.show(alert.severity, text, options, labels);
    if (picked === undefined) {
      // Dismissed. Reported so the server can tell "seen and ignored" from
      // "never delivered", but the alert stays outstanding.
      await this.reportDismissal(alert);
      return;
    }

    const button = buttons.find((candidate) => candidate.label === picked);
    if (button) {
      await this.respond(alert, button.buttonId, button.label);
    }
  }

  private async showSummary(outstanding: number): Promise<void> {
    const open = 'Show Alerts';
    const picked = await this.notifier.show(
      'warning',
      outstanding === 1
        ? '1 alert is awaiting your response.'
        : `${outstanding} alerts are awaiting your response.`,
      {},
      [open],
    );
    if (picked === open) {
      await vscode.commands.executeCommand('acmeAlerts.pending.focus');
    }
  }

  // -------------------------------------------------------------------------
  // Responding
  // -------------------------------------------------------------------------

  private async respond(alert: AlertRecord, buttonId: string, label: string): Promise<void> {
    const client = await this.clientFor();
    if (!client) {
      return;
    }

    try {
      await client.respondToAlert({
        alertId: alert.alertId,
        outcome: AlertOutcome.ANSWERED,
        buttonId,
        idempotencyKey: crypto.randomUUID(),
      });
      this.state = markAnswered(this.state, alert.alertId, label);
      await this.persist();
      this.log.info(`Answered ${alert.alertId} with ${buttonId}`);
    } catch (error) {
      await this.handleResponseError(alert, error);
    }
  }

  private async reportDismissal(alert: AlertRecord): Promise<void> {
    const client = await this.clientFor();
    if (!client) {
      return;
    }
    try {
      await client.respondToAlert({
        alertId: alert.alertId,
        outcome: AlertOutcome.DISMISSED,
        idempotencyKey: crypto.randomUUID(),
      });
    } catch (error) {
      // A dismissal is a courtesy to the server, not the user's decision.
      // Failing to record it must not produce an error the user has to dismiss
      // in turn.
      this.log.debug(`Could not report dismissal of ${alert.alertId}`, error);
    }
  }

  private async handleResponseError(alert: AlertRecord, error: unknown): Promise<void> {
    if (error instanceof ApiError && error.disposition === 'refresh') {
      // Answered in another window, or withdrawn between the notification
      // appearing and the click. The view, not the notification, is the record.
      this.log.info(`${alert.alertId}: ${error.message}`);
      this.state = markAnswered(this.state, alert.alertId, undefined);
      await this.persist();
      void vscode.window.showInformationMessage('That alert is no longer active.');
      return;
    }

    this.log.error(`Failed to answer ${alert.alertId}`, error);
    const message = error instanceof Error ? error.message : String(error);
    // Phase 7 queues this in the outbox instead of losing it.
    void vscode.window.showErrorMessage(`Could not record your answer: ${message}`);
  }

  private async promptSignIn(): Promise<void> {
    const signIn = 'Sign In';
    const picked = await vscode.window.showErrorMessage(
      'Acme Alerts could not authenticate. Check your token.',
      signIn,
    );
    if (picked === signIn) {
      await vscode.commands.executeCommand('acmeAlerts.signIn');
    }
  }

  private async persist(): Promise<void> {
    this.tree.update(this.state);
    await this.memento.update(STATE_KEY, this.state);
  }
}

const FALLBACK_BUTTONS = [{ buttonId: 'ok', label: 'OK', isPrimary: true }];

function toRecord(alert: Alert): AlertRecord {
  return {
    alertId: alert.alertId,
    severity: toSeverity(alert.severity),
    title: alert.title,
    message: alert.message,
    modal: alert.modal,
    buttons: alert.buttons.slice(0, 2).map((button, index) => ({
      buttonId: button.buttonId,
      label: button.label,
      isPrimary: button.isPrimary || index === 0,
    })),
    createdAt: alert.createdAt ? new Date(Number(alert.createdAt.seconds) * 1000).toISOString() : '',
  };
}

function toSeverity(severity: Severity): AlertSeverity {
  switch (severity) {
    case Severity.ERROR:
      return 'error';
    case Severity.WARNING:
      return 'warning';
    default:
      return 'info';
  }
}

function nextBackoff(current: number): number {
  // Jittered so a server restart does not produce a thundering herd of clients
  // reconnecting in lockstep.
  const doubled = Math.min(current * 2, MAX_BACKOFF_MS);
  const jitter = doubled * 0.2 * (Math.random() * 2 - 1);
  return Math.round(doubled + jitter);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
