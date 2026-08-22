import { describe, expect, it } from 'vitest';
import {
  BURST_THRESHOLD,
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
  type AlertStoreState,
} from './alertStore';

function alert(id: string, overrides: Partial<AlertRecord> = {}): AlertRecord {
  return {
    alertId: id,
    severity: 'warning',
    title: 'Approval needed',
    message: `message for ${id}`,
    modal: false,
    buttons: [
      { buttonId: 'approve', label: 'Approve', isPrimary: true },
      { buttonId: 'reject', label: 'Reject', isPrimary: false },
    ],
    createdAt: '2026-08-20T10:00:00.000Z',
    ...overrides,
  };
}

const NOW = new Date('2026-08-20T12:00:00.000Z');

describe('receive', () => {
  it('treats first delivery as fresh', () => {
    const { state, fresh } = receive(EMPTY_STATE, [alert('a'), alert('b')], NOW);
    expect(fresh.map((entry) => entry.alertId)).toEqual(['a', 'b']);
    expect(state.pending).toHaveLength(2);
    expect(state.pending.every((entry) => !entry.notified)).toBe(true);
  });

  it('drops a redelivery, because the stream is at-least-once', () => {
    const first = receive(EMPTY_STATE, [alert('a')], NOW);
    const second = receive(first.state, [alert('a')], NOW);
    expect(second.fresh).toEqual([]);
    expect(second.state.pending).toHaveLength(1);
  });

  it('never resurrects an alert the user already answered', () => {
    // The user answered it, then the server redelivered before its own view of
    // the world caught up - which a stream reconnect makes routine. Putting it
    // back would bounce it between pending and recent on every replay.
    const first = receive(EMPTY_STATE, [alert('a')], NOW);
    const answered = markAnswered(first.state, 'a', 'Approve', NOW);
    const redelivered = receive(answered, [alert('a')], NOW);

    expect(redelivered.fresh).toEqual([]);
    expect(redelivered.state.pending).toEqual([]);
    expect(redelivered.state.recent).toHaveLength(1);
  });

  it('restores an alert dropped locally that the server still lists, without notifying', () => {
    // Distinct from the case above: this one was never resolved here, so the
    // server listing it means it really is still outstanding.
    const first = receive(EMPTY_STATE, [alert('a')], NOW);
    const lost = { ...first.state, pending: [] };
    const redelivered = receive(lost, [alert('a')], NOW);

    expect(redelivered.fresh).toEqual([]);
    expect(redelivered.state.pending).toHaveLength(1);
    expect(redelivered.state.pending[0]?.notified).toBe(true);
  });

  it('prunes the seen set to a bounded size', () => {
    let state: AlertStoreState = EMPTY_STATE;
    for (let index = 0; index < 260; index += 1) {
      state = receive(state, [alert(`a${index}`)], NOW).state;
    }
    expect(state.seen.length).toBeLessThanOrEqual(200);
    // The most recent ids survive, so recent redeliveries are still caught.
    expect(state.seen.at(-1)?.alertId).toBe('a259');
  });

  it('forgets ids older than the retention window', () => {
    const old = receive(EMPTY_STATE, [alert('ancient')], new Date('2026-08-01T00:00:00.000Z'));
    const later = receive(old.state, [alert('b')], NOW);
    expect(later.state.seen.map((entry) => entry.alertId)).toEqual(['b']);
  });
});

describe('reconcile', () => {
  it('drops alerts the server no longer lists', () => {
    const { state } = receive(EMPTY_STATE, [alert('a'), alert('b')], NOW);
    const reconciled = reconcile(state, ['a'], NOW);
    expect(reconciled.pending.map((entry) => entry.alert.alertId)).toEqual(['a']);
    expect(reconciled.recent[0]?.alert.alertId).toBe('b');
    expect(reconciled.recent[0]?.outcome).toBe('revoked');
  });

  it('is a no-op when everything is still live, so the state object is reused', () => {
    const { state } = receive(EMPTY_STATE, [alert('a')], NOW);
    expect(reconcile(state, ['a'], NOW)).toBe(state);
  });

  it('clears everything when the server lists nothing', () => {
    const { state } = receive(EMPTY_STATE, [alert('a'), alert('b')], NOW);
    expect(reconcile(state, [], NOW).pending).toEqual([]);
  });
});

describe('markAnswered', () => {
  it('moves an alert into recent with the chosen label', () => {
    const { state } = receive(EMPTY_STATE, [alert('a')], NOW);
    const answered = markAnswered(state, 'a', 'Approve', NOW);
    expect(answered.pending).toEqual([]);
    expect(answered.recent[0]).toMatchObject({ outcome: 'answered', chosenLabel: 'Approve' });
  });

  it('ignores an unknown id rather than inventing an entry', () => {
    const { state } = receive(EMPTY_STATE, [alert('a')], NOW);
    expect(markAnswered(state, 'nope', 'Approve', NOW)).toBe(state);
  });
});

describe('markRevoked', () => {
  it('removes only the named alert', () => {
    const { state } = receive(EMPTY_STATE, [alert('a'), alert('b')], NOW);
    const revoked = markRevoked(state, 'a', NOW);
    expect(revoked.pending.map((entry) => entry.alert.alertId)).toEqual(['b']);
    expect(revoked.recent[0]?.outcome).toBe('revoked');
  });
});

describe('notification bookkeeping', () => {
  it('reports restored alerts that were never announced', () => {
    const { state } = receive(EMPTY_STATE, [alert('a'), alert('b')], NOW);
    expect(unnotified(state).map((entry) => entry.alertId)).toEqual(['a', 'b']);

    const marked = markNotified(state, ['a']);
    expect(unnotified(marked).map((entry) => entry.alertId)).toEqual(['b']);
  });
});

describe('announcementFor', () => {
  it('says nothing when nothing is new', () => {
    expect(announcementFor([], 5)).toEqual({ kind: 'none' });
  });

  it('shows individual notifications up to the burst threshold', () => {
    const fresh = [alert('a'), alert('b')];
    expect(announcementFor(fresh, BURST_THRESHOLD)).toEqual({ kind: 'individual', alerts: fresh });
  });

  it('collapses into one notification past the threshold', () => {
    // Ten stacked notifications means the user reads none of them.
    const fresh = Array.from({ length: 10 }, (_, index) => alert(`a${index}`));
    expect(announcementFor(fresh, 10)).toEqual({ kind: 'summary', outstanding: 10 });
  });

  it('collapses on total outstanding, not just the size of this batch', () => {
    // One new alert on top of a backlog is still a backlog.
    expect(announcementFor([alert('new')], BURST_THRESHOLD + 1)).toEqual({
      kind: 'summary',
      outstanding: BURST_THRESHOLD + 1,
    });
  });
});

describe('findPending', () => {
  it('returns the record for a live alert and undefined otherwise', () => {
    const { state } = receive(EMPTY_STATE, [alert('a')], NOW);
    expect(findPending(state, 'a')?.alertId).toBe('a');
    expect(findPending(state, 'b')).toBeUndefined();
  });
});
