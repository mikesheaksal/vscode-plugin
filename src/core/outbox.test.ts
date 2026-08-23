import { describe, expect, it } from 'vitest';
import {
  EMPTY_OUTBOX,
  MAX_ENTRIES,
  due,
  enqueue,
  isQueued,
  prune,
  remove,
  reschedule,
  type NewEntry,
  type OutboxState,
} from './outbox';

const NOW = new Date('2026-08-20T12:00:00.000Z');

function entry(overrides: Partial<NewEntry> = {}): NewEntry {
  return {
    id: 'out_1',
    alertId: 'alt_1',
    buttonId: 'approve',
    chosenLabel: 'Approve',
    respondedAt: NOW.toISOString(),
    idempotencyKey: 'key-1',
    ...overrides,
  };
}

describe('enqueue', () => {
  it('queues an answer as immediately due', () => {
    const state = enqueue(EMPTY_OUTBOX, entry(), NOW);
    expect(state.entries).toHaveLength(1);
    expect(due(state, NOW)).toHaveLength(1);
    expect(state.entries[0]?.attempts).toBe(0);
  });

  it('keeps the idempotency key from the original attempt', () => {
    // The key is what makes replay after an ambiguous failure record once
    // rather than twice.
    const state = enqueue(EMPTY_OUTBOX, entry({ idempotencyKey: 'key-abc' }), NOW);
    expect(state.entries[0]?.idempotencyKey).toBe('key-abc');
  });

  it('replaces an earlier queued answer for the same alert', () => {
    // Answering twice should send the second answer, not race both.
    const first = enqueue(EMPTY_OUTBOX, entry({ buttonId: 'approve' }), NOW);
    const second = enqueue(first, entry({ id: 'out_2', buttonId: 'reject' }), NOW);
    expect(second.entries).toHaveLength(1);
    expect(second.entries[0]?.buttonId).toBe('reject');
  });

  it('keeps answers for different alerts side by side', () => {
    const first = enqueue(EMPTY_OUTBOX, entry(), NOW);
    const second = enqueue(first, entry({ id: 'out_2', alertId: 'alt_2' }), NOW);
    expect(second.entries).toHaveLength(2);
  });

  it('drops the oldest past the cap, keeping the freshest answers', () => {
    let state: OutboxState = EMPTY_OUTBOX;
    for (let index = 0; index < MAX_ENTRIES + 20; index += 1) {
      state = enqueue(state, entry({ id: `out_${index}`, alertId: `alt_${index}` }), NOW);
    }
    expect(state.entries).toHaveLength(MAX_ENTRIES);
    expect(state.entries.at(-1)?.alertId).toBe(`alt_${MAX_ENTRIES + 19}`);
  });
});

describe('due', () => {
  it('excludes an entry whose retry time has not arrived', () => {
    const queued = enqueue(EMPTY_OUTBOX, entry(), NOW);
    const backedOff = reschedule(queued, 'out_1', NOW, () => 0.5);
    expect(due(backedOff, NOW)).toEqual([]);
  });

  it('includes it again once the time passes', () => {
    const queued = enqueue(EMPTY_OUTBOX, entry(), NOW);
    const backedOff = reschedule(queued, 'out_1', NOW, () => 0.5);
    const later = new Date(NOW.getTime() + 60_000);
    expect(due(backedOff, later)).toHaveLength(1);
  });
});

describe('reschedule', () => {
  it('counts attempts and backs off further each time', () => {
    let state = enqueue(EMPTY_OUTBOX, entry(), NOW);
    state = reschedule(state, 'out_1', NOW, () => 0.5);
    const first = Date.parse(state.entries[0]!.nextAttemptAt) - NOW.getTime();

    state = reschedule(state, 'out_1', NOW, () => 0.5);
    const second = Date.parse(state.entries[0]!.nextAttemptAt) - NOW.getTime();

    expect(state.entries[0]?.attempts).toBe(2);
    expect(second).toBeGreaterThan(first);
  });

  it('caps the delay rather than growing forever', () => {
    let state = enqueue(EMPTY_OUTBOX, entry(), NOW);
    for (let index = 0; index < 20; index += 1) {
      state = reschedule(state, 'out_1', NOW, () => 0.5);
    }
    const delay = Date.parse(state.entries[0]!.nextAttemptAt) - NOW.getTime();
    expect(delay).toBeLessThanOrEqual(5 * 60_000);
  });

  it('jitters, so a fleet that lost the same server does not return in lockstep', () => {
    const base = enqueue(EMPTY_OUTBOX, entry(), NOW);
    const low = reschedule(base, 'out_1', NOW, () => 0);
    const high = reschedule(base, 'out_1', NOW, () => 1);
    expect(Date.parse(low.entries[0]!.nextAttemptAt)).not.toBe(
      Date.parse(high.entries[0]!.nextAttemptAt),
    );
  });

  it('leaves other entries alone', () => {
    let state = enqueue(EMPTY_OUTBOX, entry(), NOW);
    state = enqueue(state, entry({ id: 'out_2', alertId: 'alt_2' }), NOW);
    state = reschedule(state, 'out_1', NOW, () => 0.5);
    expect(state.entries.find((e) => e.id === 'out_2')?.attempts).toBe(0);
  });
});

describe('prune', () => {
  it('drops entries older than the retention window, and reports them', () => {
    const old = enqueue(EMPTY_OUTBOX, entry(), new Date('2026-08-01T00:00:00.000Z'));
    const withFresh = enqueue(old, entry({ id: 'out_2', alertId: 'alt_2' }), NOW);

    const { state, dropped } = prune(withFresh, NOW);
    expect(state.entries).toHaveLength(1);
    expect(dropped.map((e) => e.alertId)).toEqual(['alt_1']);
  });

  it('is a no-op when nothing has expired, reusing the state object', () => {
    const state = enqueue(EMPTY_OUTBOX, entry(), NOW);
    const result = prune(state, NOW);
    expect(result.state).toBe(state);
    expect(result.dropped).toEqual([]);
  });
});

describe('remove and isQueued', () => {
  it('reports and clears a queued answer', () => {
    const state = enqueue(EMPTY_OUTBOX, entry(), NOW);
    expect(isQueued(state, 'alt_1')).toBe(true);
    expect(isQueued(state, 'alt_2')).toBe(false);
    expect(isQueued(remove(state, 'out_1'), 'alt_1')).toBe(false);
  });
});
