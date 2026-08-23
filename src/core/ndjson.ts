/**
 * Line assembler for the NDJSON stream grpc-gateway serves.
 *
 * A chunk from the network has no relationship to a message boundary: one read
 * can carry half a line, three lines, or a line split mid-multibyte-character.
 * This holds the remainder between reads and hands back only complete lines.
 *
 * No `vscode` import and no I/O, so the awkward cases can be driven directly
 * (design section 4).
 */
export class LineAssembler {
  private buffer = '';

  constructor(private readonly maxLineLength = 1_000_000) {}

  /**
   * Adds a decoded chunk and returns whatever complete lines it finished.
   * Blank lines are dropped: they carry no message and JSON.parse would throw.
   */
  push(chunk: string): string[] {
    this.buffer += chunk;

    if (this.buffer.length > this.maxLineLength && !this.buffer.includes('\n')) {
      // A server that never sends a newline would otherwise grow this without
      // bound. Failing loudly beats an extension host running out of memory.
      this.buffer = '';
      throw new Error(`Stream line exceeded ${this.maxLineLength} bytes without a newline`);
    }

    const lines: string[] = [];
    let newline = this.buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line !== '') {
        lines.push(line);
      }
      newline = this.buffer.indexOf('\n');
    }
    return lines;
  }

  /**
   * Any trailing content left when the stream ended.
   *
   * A well-behaved server terminates the last line, so anything here means the
   * connection was cut mid-message and the remainder must be discarded rather
   * than parsed.
   */
  flush(): string {
    const remainder = this.buffer;
    this.buffer = '';
    return remainder;
  }

  get pending(): number {
    return this.buffer.length;
  }
}

/**
 * One line of the stream, unwrapped from grpc-gateway's envelope.
 *
 * Messages arrive as `{"result": <Event>}`; a terminal failure arrives as
 * `{"error": <google.rpc.Status>}` and ends the stream.
 */
export type StreamLine =
  | { kind: 'result'; value: unknown }
  | { kind: 'error'; status: unknown }
  | { kind: 'unknown'; raw: string };

export function unwrapLine(line: string): StreamLine {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { kind: 'unknown', raw: line };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { kind: 'unknown', raw: line };
  }

  const record = parsed as Record<string, unknown>;
  if ('result' in record) {
    return { kind: 'result', value: record.result };
  }
  if ('error' in record) {
    return { kind: 'error', status: record.error };
  }
  return { kind: 'unknown', raw: line };
}
