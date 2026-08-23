import { describe, expect, it, vi } from 'vitest';
import { Logger } from './log';

// The Logger imports `vscode`, which does not exist outside the extension host.
// Stubbing it keeps the redaction logic — the part worth testing — under plain
// unit tests, and is why later phases keep the API and stream code free of
// `vscode` imports entirely (design §4).
const { lines } = vi.hoisted(() => ({ lines: [] as string[] }));

vi.mock('vscode', () => ({
  window: {
    createOutputChannel: () => ({
      debug: (line: string) => lines.push(line),
      info: (line: string) => lines.push(line),
      warn: (line: string) => lines.push(line),
      error: (line: string) => lines.push(line),
      show: () => undefined,
      dispose: () => undefined,
    }),
  },
}));

describe('Logger redaction', () => {
  it('scrubs a registered secret wherever it appears', () => {
    lines.length = 0;
    const log = new Logger('test');
    log.registerSecret('supersecrettoken');
    log.info('connecting with supersecrettoken now');
    expect(lines[0]).toBe('connecting with *** now');
  });

  it('ignores short values, which are more likely to be ordinary words', () => {
    lines.length = 0;
    const log = new Logger('test');
    log.registerSecret('abc');
    log.info('abc appears here');
    expect(lines[0]).toBe('abc appears here');
  });

  it('scrubs a bearer token that was never registered', () => {
    lines.length = 0;
    const log = new Logger('test');
    log.error('request failed', 'Authorization: Bearer eyJhbGciOi.J9-x_y');
    expect(lines[0]).toContain('Bearer ***');
    expect(lines[0]).not.toContain('eyJhbGciOi');
  });

  it('formats errors without dumping a stack', () => {
    lines.length = 0;
    const log = new Logger('test');
    log.error('failed', new Error('boom'));
    expect(lines[0]).toBe('failed Error: boom');
  });
});
