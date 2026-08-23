import * as vscode from 'vscode';
import {
  AlertOutcome,
  type Alert,
  type Event,
  type MachineConfigChanged,
} from '../gen/acme/alerts/v1/alerts_pb';
import { Severity } from '../gen/acme/alerts/v1/alerts_pb';
import type { ApiClient } from '../api/client';
import { ApiError, NetworkError } from '../api/errors';
import { EventStream, type StreamState } from '../api/eventStream';
import type { ConfigService } from '../config';
import {
  EMPTY_STATE,
  announcementFor,
  findPending,
  markAnswered,
  markNotified,
  markRevoked,
  receive,
  reconcile,
  unnotified,
  type AlertRecord,
  type AlertSeverity,
  type AlertStoreState,
} from '../core/alertStore';
import {
  EMPTY_OUTBOX,
  due as dueEntries,
  enqueue,
  isQueued,
  prune,
  remove,
  reschedule,
  type OutboxState,
} from '../core/outbox';
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
const SEQUENCE_KEY = 'acmeAlerts.lastSequence';
const OUTBOX_KEY = 'acmeAlerts.outbox';
const FLUSH_INTERVAL_MS = 60_000;
const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;

export interface AlertServiceOptions {
  /**
   * Handler for configuration-change events, which share the alert stream.
   * Owned by the machine apply service; this class only routes them.
   */
  onMachineConfigChanged?: (event: MachineConfigChanged) => void | Promise<void>;
  /** Skip the event stream and poll only. Used by tests of the fallback path. */
  pollOnly?: boolean;
  /** Passed through to EventStream. */
  heartbeatTimeoutMs?: number;
  failuresBeforeDegraded?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /**
   * How long freshly arrived alerts are collected before announcing them, so a
   * burst over the stream is one decision rather than one per event.
   */
  announceDebounceMs?: number;
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
 * The event stream is the primary source. Polling remains as the fallback for
 * environments where a proxy buffers the streaming response into uselessness,
 * and runs only while the stream reports itself degraded.
 */
export class AlertService implements vscode.Disposable {
  private state: AlertStoreState;
  private running = false;
  private backoffMs = MIN_BACKOFF_MS;
  private abort: AbortController | undefined;
  private stream: EventStream | undefined;
  private polling = false;
  private lastSequence: bigint;
  private readonly pollWaitSeconds: number;
  private readonly minIntervalMs: number;
  private readonly options: AlertServiceOptions;
  private readonly announceQueue: AlertRecord[] = [];
  private announceTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly announceDebounceMs: number;
  private outbox: OutboxState;
  private flushTimer: ReturnType<typeof setInterval> | undefined;
  private flushing = false;
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
    this.options = options;
    this.pollWaitSeconds = options.pollWaitSeconds ?? 30;
    this.minIntervalMs = options.minIntervalMs ?? 5_000;
    this.announceDebounceMs = options.announceDebounceMs ?? 300;
    // Stored as a string: JSON has no bigint, and uint64 does not fit a number.
    this.lastSequence = BigInt(this.memento.get<string>(SEQUENCE_KEY) ?? '0');
    this.outbox = this.memento.get<OutboxState>(OUTBOX_KEY) ?? EMPTY_OUTBOX;
  }

  /**
   * Restores persisted alerts and starts polling.
   *
   * Restored alerts are deliberately not re-notified one by one: replaying
   * six-day-old notifications at every window open is how users learn to click
   * things away without reading them (design section 7.4).
   */
  async start(): Promise<void> {
    this.tree.update(this.state, new Set(this.outbox.entries.map((entry) => entry.alertId)));

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

    // Answers left queued by a previous session go out before anything else:
    // the user made those decisions, possibly days ago.
    await this.flushOutbox();

    if (this.running) {
      return;
    }
    this.running = true;

    if (this.options.pollOnly) {
      this.startPolling();
      return;
    }

    this.stream = new EventStream({
      clientFor: this.clientFor,
      onEvent: (event) => this.onStreamEvent(event),
      onStateChange: (state, detail) => void this.onStreamState(state, detail),
      onFatal: (error) => void this.onFatal(error),
      log: this.log,
      ...pick(this.options, [
        'heartbeatTimeoutMs',
        'failuresBeforeDegraded',
        'minBackoffMs',
        'maxBackoffMs',
      ]),
    });
    this.stream.start(this.lastSequence);
  }

  stop(): void {
    this.running = false;
    this.polling = false;
    if (this.flushTimer !== undefined) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (this.announceTimer !== undefined) {
      clearTimeout(this.announceTimer);
      this.announceTimer = undefined;
    }
    this.abort?.abort();
    this.stream?.stop();
    this.stream = undefined;
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
  // Event stream
  // -------------------------------------------------------------------------

  private async onStreamEvent(event: Event): Promise<void> {
    switch (event.payload.case) {
      case 'alert':
        await this.ingest([event.payload.value], false);
        break;
      case 'alertRevoked': {
        const alertId = event.payload.value.alertId;
        this.log.info(`Alert ${alertId} withdrawn by the server`);
        this.state = markRevoked(this.state, alertId);
        await this.persist();
        // The notification for it cannot be closed programmatically, so the
        // view is where the withdrawal becomes visible (design section 7.4).
        break;
      }
      case 'machineConfigChanged':
        this.log.debug('Machine configuration changed');
        await this.options.onMachineConfigChanged?.(event.payload.value);
        break;
      case 'heartbeat':
        break;
      default:
        break;
    }
    await this.rememberSequence();
  }

  private async onStreamState(state: StreamState, detail?: string): Promise<void> {
    this.log.debug(`Stream ${state}${detail ? `: ${detail}` : ''}`);

    if (state === 'connected') {
      // The server is authoritative about what is still live, so reconcile on
      // every (re)connect: anything answered or withdrawn during an outage is
      // absent from this list even though no event announced it.
      this.polling = false;
      await this.flushOutbox();
      await this.catchUp();
      return;
    }

    if (state === 'degraded' && !this.polling) {
      // Probably a proxy buffering the stream. Fall back rather than leaving
      // the user with nothing.
      this.log.warn('Event stream unavailable; falling back to polling.');
      this.startPolling();
    }
  }

  private async onFatal(error: ApiError): Promise<void> {
    const stop = await this.handlePollError(error);
    if (stop) {
      this.stop();
    }
  }

  /** One non-blocking poll, used to reconcile after connecting. */
  private async catchUp(): Promise<void> {
    const client = await this.clientFor();
    if (!client) {
      return;
    }
    try {
      const response = await client.listPendingAlerts(0);
      await this.ingest(response.alerts, true);
    } catch (error) {
      this.log.debug('Catch-up poll failed', error);
    }
  }

  // -------------------------------------------------------------------------
  // Polling fallback
  // -------------------------------------------------------------------------

  private startPolling(): void {
    if (this.polling) {
      return;
    }
    this.polling = true;
    void this.poll();
  }

  private async poll(): Promise<void> {
    while (this.running && this.polling) {
      const client = await this.clientFor();
      if (!client) {
        // Not configured yet. ConfigService fires onDidChange when that
        // changes, and the extension restarts us.
        this.polling = false;
        this.running = false;
        return;
      }

      this.abort = new AbortController();
      try {
        const response = await client.listPendingAlerts(this.pollWaitSeconds, this.abort.signal);
        await this.ingest(response.alerts, true);
        this.backoffMs = MIN_BACKOFF_MS;
        this.reauthAttempted = false;

        // The server answers instantly while anything is outstanding, so pace
        // the loop rather than re-asking as fast as the network allows.
        if (response.alerts.length > 0) {
          await delay(this.minIntervalMs);
        }
      } catch (error) {
        if (!this.running || !this.polling) {
          return;
        }
        const stop = await this.handlePollError(error);
        if (stop) {
          this.polling = false;
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

  /**
   * Folds alerts into the store.
   *
   * `authoritative` must be true only for a complete list from
   * ListPendingAlerts. Reconciling against a stream event would drop every
   * other outstanding alert, since a single event is not a list of what is
   * live - it is one thing that happened.
   */
  private async ingest(alerts: Alert[], authoritative: boolean): Promise<void> {
    const records = alerts.map(toRecord);

    const received = receive(this.state, records);
    this.state = authoritative
      ? reconcile(
          received.state,
          records.map((record) => record.alertId),
        )
      : received.state;

    if (received.fresh.length > 0) {
      this.log.info(`Received ${received.fresh.length} new alert(s)`);
      // Marked before the announcement is decided: the announcement is
      // debounced, and a redelivery in the meantime must not re-queue it.
      this.state = markNotified(
        this.state,
        received.fresh.map((alert) => alert.alertId),
      );
      this.queueAnnouncement(received.fresh);
    }

    await this.persist();
  }

  /**
   * Collects freshly arrived alerts briefly before announcing them.
   *
   * Over the stream, alerts arrive one event at a time, so a batch is not a
   * useful unit: six alerts in quick succession would otherwise produce three
   * individual notifications and then summaries. A short window turns them
   * back into one decision.
   */
  private queueAnnouncement(fresh: AlertRecord[]): void {
    this.announceQueue.push(...fresh);
    if (this.announceTimer !== undefined) {
      return;
    }
    this.announceTimer = setTimeout(() => {
      this.announceTimer = undefined;
      // Anything already resolved during the debounce window is dropped: an
      // alert replayed and withdrawn in the same breath should not produce a
      // notification for something that is no longer there.
      const queued = this.announceQueue
        .splice(0)
        .filter((alert) => findPending(this.state, alert.alertId) !== undefined);
      const announcement = announcementFor(queued, this.state.pending.length);
      if (announcement.kind === 'individual') {
        for (const alert of announcement.alerts) {
          void this.present(alert, alert.modal);
        }
      } else if (announcement.kind === 'summary') {
        void this.showSummary(announcement.outstanding);
      }
    }, this.announceDebounceMs);
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
    // Generated once for the user's action and reused by every retry, so an
    // ambiguous failure replays as the same answer rather than a second one.
    const idempotencyKey = crypto.randomUUID();
    const client = await this.clientFor();

    if (client) {
      try {
        await client.respondToAlert({
          alertId: alert.alertId,
          outcome: AlertOutcome.ANSWERED,
          buttonId,
          idempotencyKey,
        });
        this.state = markAnswered(this.state, alert.alertId, label);
        await this.persist();
        this.log.info(`Answered ${alert.alertId} with ${buttonId}`);
        // A successful send is evidence the network is back, so anything
        // waiting goes now rather than on the next timer.
        await this.flushOutbox();
        return;
      } catch (error) {
        if (!isTransient(error)) {
          await this.handleResponseError(alert, error);
          return;
        }
        this.log.warn(`Queued answer for ${alert.alertId}: ${describeError(error)}`);
      }
    }

    // The user decided; the network did not cooperate. Record the decision
    // locally and keep the send for later.
    this.outbox = enqueue(this.outbox, {
      id: crypto.randomUUID(),
      alertId: alert.alertId,
      buttonId,
      chosenLabel: label,
      respondedAt: new Date().toISOString(),
      idempotencyKey,
    });
    this.state = markAnswered(this.state, alert.alertId, label);
    await this.persist();
    this.scheduleFlush();
    void vscode.window.setStatusBarMessage('Acme Alerts: answer will be sent when reconnected', 4000);
  }

  /** True while any answer is waiting to be sent. */
  get hasQueuedAnswers(): boolean {
    return this.outbox.entries.length > 0;
  }

  isQueued(alertId: string): boolean {
    return isQueued(this.outbox, alertId);
  }

  /**
   * Sends whatever is due.
   *
   * Runs on activation, on every stream reconnect, after any successful send,
   * and on a timer while the queue is non-empty.
   */
  async flushOutbox(): Promise<void> {
    if (this.flushing) {
      return;
    }
    this.flushing = true;
    try {
      const pruned = prune(this.outbox);
      for (const dropped of pruned.dropped) {
        // Never silent: an answer disappearing without a word is worse than
        // one that never sent.
        this.log.warn(
          `Discarded a queued answer for ${dropped.alertId} after ${MAX_AGE_DAYS} days`,
        );
      }
      this.outbox = pruned.state;

      const client = await this.clientFor();
      if (!client) {
        await this.persistOutbox();
        return;
      }

      for (const entry of dueEntries(this.outbox)) {
        try {
          await client.respondToAlert({
            alertId: entry.alertId,
            outcome: AlertOutcome.ANSWERED,
            buttonId: entry.buttonId,
            idempotencyKey: entry.idempotencyKey,
          });
          this.outbox = remove(this.outbox, entry.id);
          this.log.info(`Sent queued answer for ${entry.alertId}`);
          this.tree.update(this.state, new Set(this.outbox.entries.map((e) => e.alertId)));
        } catch (error) {
          if (isTransient(error)) {
            this.outbox = reschedule(this.outbox, entry.id);
            this.log.debug(`Queued answer for ${entry.alertId} still failing`);
            break;
          }
          // The server has an opinion: already answered, withdrawn, or
          // rejected. Retrying will not change it.
          this.outbox = remove(this.outbox, entry.id);
          this.log.info(`Dropped queued answer for ${entry.alertId}: ${describeError(error)}`);
        }
      }

      await this.persistOutbox();
      if (this.outbox.entries.length === 0 && this.flushTimer !== undefined) {
        clearInterval(this.flushTimer);
        this.flushTimer = undefined;
      }
    } finally {
      this.flushing = false;
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== undefined) {
      return;
    }
    this.flushTimer = setInterval(() => void this.flushOutbox(), FLUSH_INTERVAL_MS);
  }

  private async persistOutbox(): Promise<void> {
    await this.memento.update(OUTBOX_KEY, this.outbox);
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

  private async rememberSequence(): Promise<void> {
    const sequence = this.stream?.sequence ?? this.lastSequence;
    if (sequence === this.lastSequence) {
      return;
    }
    this.lastSequence = sequence;
    await this.memento.update(SEQUENCE_KEY, sequence.toString());
  }

  private async persist(): Promise<void> {
    this.tree.update(this.state, new Set(this.outbox.entries.map((entry) => entry.alertId)));
    await this.memento.update(STATE_KEY, this.state);
    await this.persistOutbox();
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

const MAX_AGE_DAYS = 7;

/** Worth retrying: the request never reached a server that had an opinion. */
function isTransient(error: unknown): boolean {
  if (error instanceof NetworkError) {
    return true;
  }
  return error instanceof ApiError && error.disposition === 'retry';
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Copies only the keys that are set, which `exactOptionalPropertyTypes` requires. */
function pick<T extends object, K extends keyof T>(source: T, keys: K[]): Partial<Pick<T, K>> {
  const result: Partial<Pick<T, K>> = {};
  for (const key of keys) {
    if (source[key] !== undefined) {
      result[key] = source[key];
    }
  }
  return result;
}
