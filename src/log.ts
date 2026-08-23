import * as vscode from 'vscode';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Output-channel logger with secret redaction.
 *
 * Redaction is a property of the logger rather than of each call site because
 * the one place a token reliably leaks is the log line nobody thought about.
 * Register a secret once (§6.2 of the design) and every later line is scrubbed,
 * including ones written by code that has no idea a secret exists.
 */
/** How many recent lines the Report Issue command can include. */
const HISTORY_LIMIT = 200;

export class Logger implements vscode.Disposable {
  private readonly channel: vscode.LogOutputChannel;
  private readonly secrets = new Set<string>();
  /**
   * A ring of recent lines, already redacted, so a diagnostics report can be
   * assembled without the user copying an output panel by hand — and without
   * any path that could reach an unredacted line.
   */
  private readonly history: string[] = [];

  constructor(name: string) {
    this.channel = vscode.window.createOutputChannel(name, { log: true });
  }

  /** Values to scrub from every subsequent line. Short values are ignored. */
  registerSecret(value: string | undefined): void {
    if (value && value.length >= 8) {
      this.secrets.add(value);
    }
  }

  forgetSecrets(): void {
    this.secrets.clear();
  }

  debug(message: string, ...args: unknown[]): void {
    this.write('debug', message, args);
  }

  info(message: string, ...args: unknown[]): void {
    this.write('info', message, args);
  }

  warn(message: string, ...args: unknown[]): void {
    this.write('warn', message, args);
  }

  error(message: string, ...args: unknown[]): void {
    this.write('error', message, args);
  }

  show(): void {
    this.channel.show(true);
  }

  dispose(): void {
    this.channel.dispose();
  }

  /** The most recent lines, oldest first. Already redacted. */
  recent(limit = HISTORY_LIMIT): string[] {
    return this.history.slice(-limit);
  }

  private write(level: LogLevel, message: string, args: unknown[]): void {
    const line = this.redact([message, ...args.map(formatArg)].join(' '));
    this.history.push(`[${level}] ${line}`);
    if (this.history.length > HISTORY_LIMIT) {
      this.history.splice(0, this.history.length - HISTORY_LIMIT);
    }
    switch (level) {
      case 'debug':
        this.channel.debug(line);
        break;
      case 'info':
        this.channel.info(line);
        break;
      case 'warn':
        this.channel.warn(line);
        break;
      case 'error':
        this.channel.error(line);
        break;
    }
  }

  private redact(line: string): string {
    let out = line;
    for (const secret of this.secrets) {
      out = out.split(secret).join('***');
    }
    // Catches a bearer token that reached the log by a route we did not think
    // of, and so was never registered.
    return out.replace(/(Bearer\s+)[\w.\-~+/]+=*/gi, '$1***');
  }
}

function formatArg(arg: unknown): string {
  if (typeof arg === 'string') {
    return arg;
  }
  if (arg instanceof Error) {
    return `${arg.name}: ${arg.message}`;
  }
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}
