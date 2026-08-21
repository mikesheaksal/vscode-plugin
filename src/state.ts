import * as vscode from 'vscode';

/**
 * Coarse extension state, mirrored into the `acmeAlerts.state` context key so
 * `viewsWelcome` in package.json can switch on it.
 *
 * Phase 1 only distinguishes configured from not. Later phases add the states
 * that need a server round trip to establish.
 */
export type ExtensionState = 'unconfigured' | 'ready';

export class StateController {
  private current: ExtensionState = 'unconfigured';

  private readonly emitter = new vscode.EventEmitter<ExtensionState>();
  readonly onDidChange = this.emitter.event;

  get value(): ExtensionState {
    return this.current;
  }

  async set(next: ExtensionState): Promise<void> {
    if (next === this.current) {
      return;
    }
    this.current = next;
    await vscode.commands.executeCommand('setContext', 'acmeAlerts.state', next);
    this.emitter.fire(next);
  }

  /** Push the current value to the context key without firing a change. */
  async sync(): Promise<void> {
    await vscode.commands.executeCommand('setContext', 'acmeAlerts.state', this.current);
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
