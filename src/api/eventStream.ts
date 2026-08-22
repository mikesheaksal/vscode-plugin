import { fromJson } from '@bufbuild/protobuf';
import { EventSchema, type Event } from '../gen/acme/alerts/v1/alerts_pb';
import { Backoff } from '../core/backoff';
import { LineAssembler, unwrapLine } from '../core/ndjson';
import type { ApiClient } from './client';
import { ApiError, NetworkError, parseErrorBody } from './errors';

/**
 * The long-lived event stream, with reconnection.
 *
 * The response is NDJSON over chunked HTTP, not Server-Sent Events: no `data:`
 * framing, no browser auto-reconnect, and resumption by `lastSequence` rather
 * than a Last-Event-ID header (design section 5.1). The browser EventSource API
 * would not have worked here anyway, since it cannot set an Authorization
 * header.
 *
 * No `vscode` import: this runs on fetch and timers alone.
 */

export type StreamState =
  /** Opening, or waiting to retry. */
  | 'connecting'
  /** Bytes are flowing. */
  | 'connected'
  /** Repeated failures; the caller should poll instead until this recovers. */
  | 'degraded'
  | 'stopped';

export interface EventStreamOptions {
  /** Resolves the client, or undefined when the extension is unconfigured. */
  clientFor: () => Promise<ApiClient | undefined>;
  onEvent: (event: Event) => void | Promise<void>;
  onStateChange?: (state: StreamState, detail?: string) => void;
  /**
   * Called when the stream is authoritatively rejected. The caller decides
   * whether to re-resolve credentials or stop; the stream itself does not
   * retry these.
   */
  onFatal?: (error: ApiError) => void;
  log?: { debug(message: string, ...args: unknown[]): void; warn(message: string): void };

  /**
   * A half-open TCP connection is invisible: no error, no data, forever. The
   * server heartbeats every 25s, so silence past this is treated as a dead
   * socket and the connection is torn down.
   */
  heartbeatTimeoutMs?: number;
  /** Consecutive failures before reporting 'degraded' so the caller can poll. */
  failuresBeforeDegraded?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  random?: () => number;
}

export class EventStream {
  private running = false;
  private abort: AbortController | undefined;
  private state: StreamState = 'stopped';
  private lastSequence = 0n;
  private readonly backoff: Backoff;
  private readonly heartbeatTimeoutMs: number;
  private readonly failuresBeforeDegraded: number;

  constructor(private readonly options: EventStreamOptions) {
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 60_000;
    this.failuresBeforeDegraded = options.failuresBeforeDegraded ?? 5;
    this.backoff = new Backoff({
      ...(options.minBackoffMs !== undefined ? { minMs: options.minBackoffMs } : {}),
      ...(options.maxBackoffMs !== undefined ? { maxMs: options.maxBackoffMs } : {}),
      ...(options.random !== undefined ? { random: options.random } : {}),
    });
  }

  /** Highest sequence handled, for persisting across restarts. */
  get sequence(): bigint {
    return this.lastSequence;
  }

  start(fromSequence: bigint): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.lastSequence = fromSequence;
    void this.run();
  }

  stop(): void {
    this.running = false;
    this.abort?.abort();
    this.setState('stopped');
  }

  private async run(): Promise<void> {
    while (this.running) {
      this.setState('connecting');
      let delivered = false;

      try {
        delivered = await this.connectAndRead();
      } catch (error) {
        if (!this.running) {
          break;
        }
        if (error instanceof ApiError && isFatal(error)) {
          // A rejected token or a token not paired with this client id will be
          // rejected identically on every retry. Hand it to the caller and stop.
          this.options.log?.warn(`Stream rejected: ${error.message}`);
          this.options.onFatal?.(error);
          this.running = false;
          this.setState('stopped', error.message);
          return;
        }
        this.options.log?.debug(`Stream failed: ${describe(error)}`);
      }

      if (!this.running) {
        break;
      }

      // A connection that delivered something before dropping was working, so
      // it should not inherit the backoff of one that never connected at all.
      if (delivered) {
        this.backoff.reset();
      }

      const wait = this.backoff.next();
      if (this.backoff.failures >= this.failuresBeforeDegraded) {
        this.setState('degraded', `${this.backoff.failures} consecutive failures`);
      }
      await sleep(wait, () => !this.running);
    }
    this.setState('stopped');
  }

  /** Returns true if at least one event arrived before the stream ended. */
  private async connectAndRead(): Promise<boolean> {
    const client = await this.options.clientFor();
    if (!client) {
      throw new NetworkError('not configured');
    }

    this.abort = new AbortController();
    const controller = this.abort;

    // Reset on every read, not on every event: a heartbeat is bytes too, and
    // this is about detecting a dead socket rather than an idle server.
    let watchdog = setTimeout(() => controller.abort(), this.heartbeatTimeoutMs);
    const resetWatchdog = (): void => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => controller.abort(), this.heartbeatTimeoutMs);
    };

    let response: Response;
    try {
      response = await fetch(client.eventStreamUrl(this.lastSequence), {
        headers: client.headers(),
        signal: controller.signal,
      });
    } catch (cause) {
      clearTimeout(watchdog);
      throw new NetworkError(describe(cause), cause);
    }

    if (!response.ok) {
      clearTimeout(watchdog);
      const text = await response.text().catch(() => '');
      throw parseErrorBody(safeParse(text), response.status);
    }

    const body = response.body;
    if (!body) {
      clearTimeout(watchdog);
      throw new NetworkError('stream response had no body');
    }

    this.setState('connected');
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const assembler = new LineAssembler();
    let delivered = false;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        resetWatchdog();

        for (const line of assembler.push(decoder.decode(value, { stream: true }))) {
          const handled = await this.handleLine(line);
          delivered ||= handled;
        }
      }
      // A trailing fragment means the connection was cut mid-message; parsing
      // it would produce a half-event.
      if (assembler.pending > 0) {
        this.options.log?.debug('Stream ended mid-line; discarding the fragment');
        assembler.flush();
      }
    } finally {
      clearTimeout(watchdog);
      reader.cancel().catch(() => undefined);
    }

    return delivered;
  }

  /** Returns true when the line carried an event we handled. */
  private async handleLine(line: string): Promise<boolean> {
    const unwrapped = unwrapLine(line);

    if (unwrapped.kind === 'unknown') {
      // Never fatal: a gateway or proxy that adds a line we do not recognise
      // must not take the stream down.
      this.options.log?.debug(`Ignoring unrecognised stream line: ${unwrapped.raw.slice(0, 120)}`);
      return false;
    }

    if (unwrapped.kind === 'error') {
      throw parseErrorBody(unwrapped.status, 500);
    }

    let event: Event;
    try {
      event = fromJson(EventSchema, unwrapped.value as never, { ignoreUnknownFields: true });
    } catch (cause) {
      this.options.log?.debug(`Could not parse stream event: ${describe(cause)}`);
      return false;
    }

    // Only advance past events we actually handled, so a reconnect replays
    // anything that arrived while we were failing to process it.
    if (event.sequence > this.lastSequence) {
      this.lastSequence = event.sequence;
    }
    await this.options.onEvent(event);
    return true;
  }

  private setState(state: StreamState, detail?: string): void {
    if (this.state === state) {
      return;
    }
    this.state = state;
    this.options.onStateChange?.(state, detail);
  }
}

/** Retrying these would fail identically every time. */
function isFatal(error: ApiError): boolean {
  return error.disposition === 'reauthenticate' || error.disposition === 'not-authorized';
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 200) };
  }
}

/** Sleeps, waking early if the cancellation predicate turns true. */
async function sleep(ms: number, cancelled: () => boolean): Promise<void> {
  const step = 100;
  for (let waited = 0; waited < ms; waited += step) {
    if (cancelled()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(step, ms - waited)));
  }
}
