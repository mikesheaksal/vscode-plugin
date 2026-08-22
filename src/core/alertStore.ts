/**
 * Alert bookkeeping: what is outstanding, what has been shown, what was
 * answered. No `vscode` import, and no protobuf types — alerts are converted to
 * a plain record at the boundary so the persisted shape is stable and trivially
 * serialisable (design section 4).
 *
 * Alerts have no client-side expiry. One stays outstanding until the user
 * answers it or the server withdraws it, which is why this state is persisted
 * and restored rather than rebuilt from each poll.
 */

export type AlertSeverity = 'info' | 'warning' | 'error';

export interface AlertButtonRecord {
  buttonId: string;
  label: string;
  isPrimary: boolean;
}

export interface AlertRecord {
  alertId: string;
  severity: AlertSeverity;
  title: string;
  message: string;
  modal: boolean;
  buttons: AlertButtonRecord[];
  createdAt: string;
}

export interface PendingAlert {
  alert: AlertRecord;
  /** Whether a notification has already been shown for this alert. */
  notified: boolean;
  /** When this client first saw it, ISO 8601. */
  receivedAt: string;
}

export interface AnsweredAlert {
  alert: AlertRecord;
  /** Label of the chosen button, or undefined when the server withdrew it. */
  chosenLabel?: string | undefined;
  answeredAt: string;
  outcome: 'answered' | 'revoked';
}

export interface AlertStoreState {
  pending: PendingAlert[];
  /** Answered or withdrawn, newest first. Bounded. */
  recent: AnsweredAlert[];
  /** Ids seen at any point, with the time they were seen, for deduplication. */
  seen: Array<{ alertId: string; at: string }>;
}

export const EMPTY_STATE: AlertStoreState = { pending: [], recent: [], seen: [] };

/** Past this many outstanding alerts, notifications coalesce into one (design 7.3). */
export const BURST_THRESHOLD = 3;

const MAX_SEEN = 200;
const MAX_RECENT = 50;
const SEEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface ReceiveResult {
  state: AlertStoreState;
  /** Alerts never seen before, in arrival order. These are the ones to notify about. */
  fresh: AlertRecord[];
}

/**
 * Folds a batch of alerts from the server into the state.
 *
 * Delivery is at-least-once — a reconnect with `last_sequence` can legitimately
 * re-deliver — so an id already in `seen` is dropped before anything is shown.
 */
export function receive(
  state: AlertStoreState,
  incoming: AlertRecord[],
  now: Date = new Date(),
): ReceiveResult {
  const seenIds = new Set(state.seen.map((entry) => entry.alertId));
  const pendingIds = new Set(state.pending.map((entry) => entry.alert.alertId));
  const resolvedIds = new Set(state.recent.map((entry) => entry.alert.alertId));

  const fresh: AlertRecord[] = [];
  const pending = [...state.pending];
  const seen = [...state.seen];

  for (const alert of incoming) {
    if (seenIds.has(alert.alertId)) {
      // Already known. Re-add to pending if it was dropped locally while the
      // server still considers it live, but never re-notify - and never
      // resurrect one the user has already answered, which would otherwise
      // bounce between pending and recent on every redelivery.
      if (!pendingIds.has(alert.alertId) && !resolvedIds.has(alert.alertId)) {
        pending.push({ alert, notified: true, receivedAt: now.toISOString() });
        pendingIds.add(alert.alertId);
      }
      continue;
    }
    seenIds.add(alert.alertId);
    seen.push({ alertId: alert.alertId, at: now.toISOString() });
    pending.push({ alert, notified: false, receivedAt: now.toISOString() });
    pendingIds.add(alert.alertId);
    fresh.push(alert);
  }

  return { state: { ...state, pending, seen: pruneSeen(seen, now) }, fresh };
}

/**
 * Drops locally pending alerts the server no longer lists.
 *
 * The server is authoritative about what is still live, so anything held here
 * but absent from its response was answered elsewhere or withdrawn while this
 * client was away. Only call this with a complete list.
 */
export function reconcile(
  state: AlertStoreState,
  liveAlertIds: string[],
  now: Date = new Date(),
): AlertStoreState {
  const live = new Set(liveAlertIds);
  const kept: PendingAlert[] = [];
  const removed: AnsweredAlert[] = [];

  for (const entry of state.pending) {
    if (live.has(entry.alert.alertId)) {
      kept.push(entry);
    } else {
      removed.push({
        alert: entry.alert,
        answeredAt: now.toISOString(),
        outcome: 'revoked',
      });
    }
  }

  if (removed.length === 0) {
    return state;
  }
  return { ...state, pending: kept, recent: [...removed, ...state.recent].slice(0, MAX_RECENT) };
}

/** Marks an alert as answered locally, moving it out of the pending list. */
export function markAnswered(
  state: AlertStoreState,
  alertId: string,
  chosenLabel: string | undefined,
  now: Date = new Date(),
): AlertStoreState {
  const entry = state.pending.find((candidate) => candidate.alert.alertId === alertId);
  if (!entry) {
    return state;
  }
  const answered: AnsweredAlert = {
    alert: entry.alert,
    chosenLabel,
    answeredAt: now.toISOString(),
    outcome: 'answered',
  };
  return {
    ...state,
    pending: state.pending.filter((candidate) => candidate.alert.alertId !== alertId),
    recent: [answered, ...state.recent].slice(0, MAX_RECENT),
  };
}

/** Removes an alert the server withdrew. */
export function markRevoked(
  state: AlertStoreState,
  alertId: string,
  now: Date = new Date(),
): AlertStoreState {
  return reconcile(
    state,
    state.pending
      .map((entry) => entry.alert.alertId)
      .filter((candidate) => candidate !== alertId),
    now,
  );
}

export function markNotified(state: AlertStoreState, alertIds: string[]): AlertStoreState {
  const ids = new Set(alertIds);
  return {
    ...state,
    pending: state.pending.map((entry) =>
      ids.has(entry.alert.alertId) ? { ...entry, notified: true } : entry,
    ),
  };
}

export function findPending(state: AlertStoreState, alertId: string): AlertRecord | undefined {
  return state.pending.find((entry) => entry.alert.alertId === alertId)?.alert;
}

/** Alerts restored from disk that have never had a notification shown. */
export function unnotified(state: AlertStoreState): AlertRecord[] {
  return state.pending.filter((entry) => !entry.notified).map((entry) => entry.alert);
}

/**
 * How to announce a batch.
 *
 * Ten alerts at once would produce ten stacked notifications and the user would
 * miss most of them, so past the threshold they collapse into one that points
 * at the view.
 */
export function announcementFor(
  fresh: AlertRecord[],
  outstanding: number,
): { kind: 'none' } | { kind: 'individual'; alerts: AlertRecord[] } | { kind: 'summary'; outstanding: number } {
  if (fresh.length === 0) {
    return { kind: 'none' };
  }
  if (outstanding > BURST_THRESHOLD) {
    return { kind: 'summary', outstanding };
  }
  return { kind: 'individual', alerts: fresh };
}

/**
 * Keeps the dedupe set bounded in both age and size. Without the TTL a
 * long-lived install grows the set forever; without the cap, a burst does.
 */
function pruneSeen(
  seen: Array<{ alertId: string; at: string }>,
  now: Date,
): Array<{ alertId: string; at: string }> {
  const cutoff = now.getTime() - SEEN_TTL_MS;
  return seen.filter((entry) => Date.parse(entry.at) >= cutoff).slice(-MAX_SEEN);
}
