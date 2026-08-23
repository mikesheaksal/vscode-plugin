import * as vscode from 'vscode';
import type { CredentialState } from './config';

/**
 * Coarse extension state, mirrored into the `acmeAlerts.state` context key so
 * `viewsWelcome` in package.json can switch on it.
 *
 * Every value names a specific reason the extension is not working, so a user
 * who sees an inert sidebar is told what to do about it rather than being left
 * with an empty pane. 'ready' means credentials resolved; whether the server
 * accepts them is a Phase 3 question.
 */
export type ExtensionState = CredentialState['kind'];

export class StateController {
  private current: ExtensionState = 'no-server-url';

  private readonly emitter = new vscode.EventEmitter<ExtensionState>();
  readonly onDidChange = this.emitter.event;

  get value(): ExtensionState {
    return this.current;
  }

  async set(next: ExtensionState): Promise<void> {
    const changed = next !== this.current;
    this.current = next;
    // Pushed even when unchanged: the context key does not survive a window
    // reload, and a missing key renders no welcome view at all.
    await vscode.commands.executeCommand('setContext', 'acmeAlerts.state', next);
    if (changed) {
      this.emitter.fire(next);
    }
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
