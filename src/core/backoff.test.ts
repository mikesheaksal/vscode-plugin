import { describe, expect, it } from 'vitest';
import { Backoff } from './backoff';

/** No jitter, so the growth curve itself can be asserted. */
function steady(overrides = {}): Backoff {
  return new Backoff({ minMs: 1000, maxMs: 60_000, jitter: 0, ...overrides });
}

describe('Backoff', () => {
  it('doubles from the minimum', () => {
    const backoff = steady();
    expect([backoff.next(), backoff.next(), backoff.next(), backoff.next()]).toEqual([
      1000, 2000, 4000, 8000,
    ]);
  });

  it('caps at the maximum rather than growing forever', () => {
    const backoff = steady();
    for (let index = 0; index < 20; index += 1) {
      backoff.next();
    }
    expect(backoff.next()).toBe(60_000);
  });

  it('counts consecutive failures, which is what drives the fallback decision', () => {
    const backoff = steady();
    expect(backoff.failures).toBe(0);
    backoff.next();
    backoff.next();
    expect(backoff.failures).toBe(2);
  });

  it('starts over after a reset', () => {
    const backoff = steady();
    backoff.next();
    backoff.next();
    backoff.reset();
    expect(backoff.failures).toBe(0);
    expect(backoff.next()).toBe(1000);
  });

  it('spreads the herd: the same step varies between clients', () => {
    // A server restart drops every client at once. Without jitter they all
    // come back in lockstep and knock it over again.
    const low = new Backoff({ minMs: 1000, maxMs: 60_000, jitter: 0.2, random: () => 0 });
    const high = new Backoff({ minMs: 1000, maxMs: 60_000, jitter: 0.2, random: () => 1 });
    low.next();
    high.next();
    expect(low.next()).toBe(1600);
    expect(high.next()).toBe(2400);
  });

  it('never returns less than the minimum, even at the low end of the jitter', () => {
    const backoff = new Backoff({ minMs: 1000, maxMs: 60_000, jitter: 0.9, random: () => 0 });
    expect(backoff.next()).toBe(1000);
  });
});
