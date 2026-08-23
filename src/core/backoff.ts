/**
 * Reconnect pacing.
 *
 * Exponential with jitter, because a server restart drops every client at once
 * and un-jittered backoff brings them all back in lockstep — the restart's own
 * thundering herd.
 */
export interface BackoffOptions {
  minMs?: number;
  maxMs?: number;
  /** Fraction of the delay to vary by, 0.2 meaning plus or minus 20%. */
  jitter?: number;
  /** Injectable for tests. */
  random?: () => number;
}

export class Backoff {
  private readonly minMs: number;
  private readonly maxMs: number;
  private readonly jitter: number;
  private readonly random: () => number;
  private attempt = 0;

  constructor(options: BackoffOptions = {}) {
    this.minMs = options.minMs ?? 1_000;
    this.maxMs = options.maxMs ?? 60_000;
    this.jitter = options.jitter ?? 0.2;
    this.random = options.random ?? Math.random;
  }

  /** Consecutive failures since the last reset. */
  get failures(): number {
    return this.attempt;
  }

  /** Advances one step and returns how long to wait. */
  next(): number {
    const base = Math.min(this.minMs * 2 ** this.attempt, this.maxMs);
    this.attempt += 1;
    const spread = base * this.jitter;
    const offset = spread * (this.random() * 2 - 1);
    // Never below minMs: jitter should spread the herd, not defeat the backoff.
    return Math.max(this.minMs, Math.round(base + offset));
  }

  /** Call after anything that proves the connection is working again. */
  reset(): void {
    this.attempt = 0;
  }
}
