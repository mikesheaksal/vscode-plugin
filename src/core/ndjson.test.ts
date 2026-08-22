import { describe, expect, it } from 'vitest';
import { LineAssembler, unwrapLine } from './ndjson';

describe('LineAssembler', () => {
  it('returns complete lines and holds the remainder', () => {
    const assembler = new LineAssembler();
    expect(assembler.push('{"a":1}\n{"b":')).toEqual(['{"a":1}']);
    expect(assembler.push('2}\n')).toEqual(['{"b":2}']);
  });

  it('handles several lines arriving in one chunk', () => {
    const assembler = new LineAssembler();
    expect(assembler.push('a\nb\nc\n')).toEqual(['a', 'b', 'c']);
  });

  it('handles a line split across three reads', () => {
    // Chunk boundaries have no relationship to message boundaries.
    const assembler = new LineAssembler();
    expect(assembler.push('{"seq')).toEqual([]);
    expect(assembler.push('uence":')).toEqual([]);
    expect(assembler.push('"41"}\n')).toEqual(['{"sequence":"41"}']);
  });

  it('drops blank lines rather than emitting something JSON.parse would reject', () => {
    const assembler = new LineAssembler();
    expect(assembler.push('a\n\n\nb\n')).toEqual(['a', 'b']);
  });

  it('trims CRLF line endings', () => {
    const assembler = new LineAssembler();
    expect(assembler.push('{"a":1}\r\n')).toEqual(['{"a":1}']);
  });

  it('reports a trailing fragment, so a cut connection is not parsed as a message', () => {
    const assembler = new LineAssembler();
    assembler.push('{"complete":1}\n{"cut":');
    expect(assembler.pending).toBeGreaterThan(0);
    expect(assembler.flush()).toBe('{"cut":');
    expect(assembler.pending).toBe(0);
  });

  it('refuses to buffer without bound when a server never sends a newline', () => {
    const assembler = new LineAssembler(64);
    expect(() => assembler.push('x'.repeat(100))).toThrow(/without a newline/);
    // The buffer is cleared, so the next connection starts clean.
    expect(assembler.pending).toBe(0);
  });

  it('allows a long line that does terminate', () => {
    const assembler = new LineAssembler(64);
    const long = 'x'.repeat(100);
    expect(assembler.push(`${long}\n`)).toEqual([long]);
  });
});

describe('unwrapLine', () => {
  it('unwraps the result envelope grpc-gateway uses for stream messages', () => {
    expect(unwrapLine('{"result":{"sequence":"41"}}')).toEqual({
      kind: 'result',
      value: { sequence: '41' },
    });
  });

  it('recognises a terminal error line', () => {
    const line = unwrapLine('{"error":{"code":16,"message":"token expired"}}');
    expect(line.kind).toBe('error');
  });

  it('reports anything else as unknown rather than throwing', () => {
    // A proxy that injects a line must not take the stream down.
    expect(unwrapLine('not json').kind).toBe('unknown');
    expect(unwrapLine('{"unexpected":1}').kind).toBe('unknown');
    expect(unwrapLine('[1,2,3]').kind).toBe('unknown');
    expect(unwrapLine('null').kind).toBe('unknown');
  });
});
