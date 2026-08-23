/**
 * A durable queue for answers that could not be sent.
 *
 * A user who clicks Approve has made a decision, and a dropped connection must
 * not quietly discard it. Every entry carries the idempotency key from the
 * original attempt, so replaying after an ambiguous failure records the answer
 * once rather than twice.
 *
 * **Alert responses only.** Machine configuration applies deliberately do not
 * use this: replaying a reconfiguration minutes later, once the network returns
 * and the user has moved on, is the opposite of what durable retry is for
 * (design section 9.1). Dismissals are also excluded — a dismissal is a
 * courtesy to the server, not the user's decision, and queueing them would fill
 * the outbox with things nobody is waiting on.
 *
 * No `vscode` import: pure state transitions over a serialisable shape.
 */

export interface OutboxEntry {
  id: string;
  alertId: string;
  buttonId: string;
  /** Label shown in the view while the answer is still queued. */
  chosenLabel: string;
  respondedAt: string;
  /** Generated once for the user's action and reused for every retry. */
  idempotencyKey: string;
  attempts: number;
  /** ISO 8601; entries are not retried before this. */
  nextAttemptAt: string;
  queuedAt: string;
}

export interface OutboxState {
  entries: OutboxEntry[];
}

export const EMPTY_OUTBOX: OutboxState = { entries: [] };

/** Bounds, so a long outage cannot grow this without limit. */
export const MAX_ENTRIES = 100;
export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const MIN_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 5 * 60_000;

export interface NewEntry {
  id: string;
  alertId: string;
  buttonId: string;
  chosenLabel: string;
  respondedAt: string;
  idempotencyKey: string;
}

export function enqueue(
  state: OutboxState,
  entry: NewEntry,
  now: Date = new Date(),
): OutboxState {
  // One queued answer per alert: a second answer to the same alert replaces
  // the first rather than racing it.
  const others = state.entries.filter((existing) => existing.alertId !== entry.alertId);
  const queued: OutboxEntry = {
    ...entry,
    attempts: 0,
    queuedAt: now.toISOString(),
    nextAttemptAt: now.toISOString(),
  };
  // Oldest first, and the cap drops the oldest: a fresh answer matters more
  // than one that has been failing for a week.
  return { entries: [...others, queued].slice(-MAX_ENTRIES) };
}

/** Entries whose retry time has arrived, oldest first. */
export function due(state: OutboxState, now: Date = new Date()): OutboxEntry[] {
  return state.entries.filter((entry) => Date.parse(entry.nextAttemptAt) <= now.getTime());
}

export function remove(state: OutboxState, id: string): OutboxState {
  return { entries: state.entries.filter((entry) => entry.id !== id) };
}

/** Records a failed attempt and schedules the next one. */
export function reschedule(
  state: OutboxState,
  id: string,
  now: Date = new Date(),
  random: () => number = Math.random,
): OutboxState {
  return {
    entries: state.entries.map((entry) => {
      if (entry.id !== id) {
        return entry;
      }
      const attempts = entry.attempts + 1;
      return {
        ...entry,
        attempts,
        nextAttemptAt: new Date(now.getTime() + backoffMs(attempts, random)).toISOString(),
      };
    }),
  };
}

/**
 * Drops entries too old to be worth sending.
 *
 * Reports what went, because an answer disappearing silently is worse than one
 * that never sent.
 */
export function prune(
  state: OutboxState,
  now: Date = new Date(),
): { state: OutboxState; dropped: OutboxEntry[] } {
  const cutoff = now.getTime() - MAX_AGE_MS;
  const kept: OutboxEntry[] = [];
  const dropped: OutboxEntry[] = [];
  for (const entry of state.entries) {
    if (Date.parse(entry.queuedAt) >= cutoff) {
      kept.push(entry);
    } else {
      dropped.push(entry);
    }
  }
  return dropped.length === 0 ? { state, dropped } : { state: { entries: kept }, dropped };
}

/** True when an alert has an answer waiting to be sent. */
export function isQueued(state: OutboxState, alertId: string): boolean {
  return state.entries.some((entry) => entry.alertId === alertId);
}

function backoffMs(attempts: number, random: () => number): number {
  const base = Math.min(MIN_BACKOFF_MS * 2 ** (attempts - 1), MAX_BACKOFF_MS);
  // Jittered, so a fleet that lost the same server does not return in lockstep.
  const spread = base * 0.2 * (random() * 2 - 1);
  return Math.max(MIN_BACKOFF_MS, Math.round(base + spread));
}
