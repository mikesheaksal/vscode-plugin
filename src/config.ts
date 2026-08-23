import { watch, type FSWatcher } from 'node:fs';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import * as vscode from 'vscode';
import {
  defaultCredentialPath,
  resolveClientId,
  resolveToken,
  type FileReader,
  type TokenSource,
} from './core/credentials';
import type { Logger } from './log';
import { nodeFiles } from './nodeFiles';

const SECTION = 'acmeAlerts';
const SECRET_KEY = 'acmeAlerts.apiToken';

/**
 * Upper bound on noticing a credential file change.
 *
 * `fs.watch` gives sub-second response where it works, but it is documented as
 * platform-dependent and CI showed it missing a rewrite on Windows. Two `stat`
 * calls on this interval cost nothing and turn "usually immediate" into a
 * guarantee, which is what the design actually promises: provisioning or
 * rotating a file brings the extension to life without a window reload.
 */
const POLL_INTERVAL_MS = 5_000;

/**
 * Why the extension cannot talk to the server yet, or that it can. These map
 * one-to-one onto the `viewsWelcome` states in package.json, so the user always
 * gets a specific reason rather than an empty view.
 */
export type CredentialState =
  | { kind: 'no-server-url' }
  | { kind: 'no-client-id'; searchedPath: string }
  | { kind: 'signed-out'; searchedPath: string }
  | { kind: 'ready'; credentials: Credentials };

export interface Credentials {
  serverUrl: string;
  clientId: string;
  token: string;
  tokenSource: TokenSource;
}

export class ConfigService implements vscode.Disposable {
  private cached: CredentialState | undefined;
  private inFlight: Promise<CredentialState> | undefined;
  private watchers: FSWatcher[] = [];
  private watchedKey = '';
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  /** Last observed mtime+size per credential file, for the safety poll. */
  private readonly fingerprints = new Map<string, string>();
  private migrationOffered = false;
  private readonly insecureWarned = new Set<string>();

  private readonly emitter = new vscode.EventEmitter<void>();
  /** Fires when a credential source changed, so callers can re-resolve. */
  readonly onDidChange = this.emitter.event;

  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly log: Logger,
    private readonly files: FileReader = nodeFiles,
    private readonly pollIntervalMs: number = POLL_INTERVAL_MS,
  ) {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(SECTION)) {
          this.log.debug('credentials: configuration changed');
          this.invalidate();
        }
      }),
      this.secrets.onDidChange((event) => {
        if (event.key === SECRET_KEY) {
          this.log.debug('credentials: secret storage changed');
          this.invalidate();
        }
      }),
    );
  }

  get tokenFilePath(): string {
    return this.pathSetting('tokenFilePath', 'token');
  }

  get clientIdFilePath(): string {
    return this.pathSetting('clientIdFilePath', 'client-id');
  }

  /**
   * Resolves the current state, reusing the cached answer. Concurrent callers
   * share one resolution rather than racing to read the same files.
   */
  async resolve(): Promise<CredentialState> {
    if (this.cached) {
      return this.cached;
    }
    this.inFlight ??= this.resolveUncached().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  /**
   * Drops the cached resolution. Called on any configuration or secret change,
   * and by the API client on a 401 - the token file may have been refreshed by
   * an external tool since we last read it (design section 6.3).
   */
  invalidate(): void {
    this.cached = undefined;
    this.emitter.fire();
  }

  /** Prompts for a token and stores it in secret storage. */
  async signIn(): Promise<void> {
    const token = await vscode.window.showInputBox({
      title: 'Acme Alerts: Sign In',
      prompt: "Paste your API token. It is stored in the editor's secret storage.",
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim() === '' ? 'A token is required.' : undefined),
    });
    if (token === undefined) {
      return;
    }
    await this.secrets.store(SECRET_KEY, token.trim());
    this.invalidate();
    this.log.info('credentials: token stored in secret storage');
    void vscode.window.showInformationMessage('Signed in to Acme Alerts.');
  }

  /** Clears the stored token, and offers to clear the setting if one is set. */
  async signOut(): Promise<void> {
    await this.secrets.delete(SECRET_KEY);
    this.log.forgetSecrets();
    if (this.settingToken().trim() !== '') {
      const clear = await vscode.window.showWarningMessage(
        'Cleared the stored token, but a token is still set in settings.json.',
        'Clear from Settings',
      );
      if (clear) {
        await this.clearSettingToken();
      }
    }
    this.invalidate();
    void vscode.window.showInformationMessage('Signed out of Acme Alerts.');
  }

  dispose(): void {
    this.emitter.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.stopWatching();
    if (this.pollTimer !== undefined) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private async resolveUncached(): Promise<CredentialState> {
    const config = vscode.workspace.getConfiguration(SECTION);
    const serverUrl = config.get<string>('serverUrl', '').trim();
    const tokenFilePath = this.tokenFilePath;
    const clientIdFilePath = this.clientIdFilePath;

    this.watchCredentialFiles(tokenFilePath, clientIdFilePath);
    this.startPolling(tokenFilePath, clientIdFilePath);

    const state = await this.determineState(serverUrl, tokenFilePath, clientIdFilePath);
    this.cached = state;
    if (state.kind !== 'ready') {
      this.log.info(`credentials: ${state.kind}`);
    }
    return state;
  }

  private async determineState(
    serverUrl: string,
    tokenFilePath: string,
    clientIdFilePath: string,
  ): Promise<CredentialState> {
    if (serverUrl === '') {
      return { kind: 'no-server-url' };
    }

    const clientId = await resolveClientId({ clientIdFilePath, tokenFilePath, files: this.files });
    if (!clientId) {
      return { kind: 'no-client-id', searchedPath: clientIdFilePath };
    }

    const token = await resolveToken({
      settingValue: this.settingToken(),
      secretValue: await this.secrets.get(SECRET_KEY),
      tokenFilePath,
      files: this.files,
    });
    if (!token) {
      return { kind: 'signed-out', searchedPath: tokenFilePath };
    }

    this.log.registerSecret(token.token);
    if (token.insecureFilePath) {
      this.warnInsecureFile(token.insecureFilePath);
    }
    if (token.source === 'settings') {
      void this.migrateSettingToken(token.token);
    }
    this.log.info(
      `credentials: ready (client id from ${clientId.source}, token from ${token.source})`,
    );
    return {
      kind: 'ready',
      credentials: {
        serverUrl,
        clientId: clientId.clientId,
        token: token.token,
        tokenSource: token.source,
      },
    };
  }

  /**
   * settings.json is plaintext and is synchronised by Settings Sync, so a token
   * left there is a standing exposure. Copy it into secret storage on first
   * read and offer to remove it (design section 6.2).
   */
  private async migrateSettingToken(token: string): Promise<void> {
    if (this.migrationOffered) {
      return;
    }
    this.migrationOffered = true;
    await this.secrets.store(SECRET_KEY, token);
    this.log.warn('credentials: token found in settings.json, copied to secret storage');

    const choice = await vscode.window.showWarningMessage(
      'Your Acme Alerts token is stored in settings.json, which Settings Sync copies between machines. It has been saved to this editor’s secret storage.',
      'Clear from Settings',
      'Keep',
    );
    if (choice === 'Clear from Settings') {
      await this.clearSettingToken();
      this.invalidate();
    }
  }

  private async clearSettingToken(): Promise<void> {
    await vscode.workspace
      .getConfiguration(SECTION)
      .update('apiToken', undefined, vscode.ConfigurationTarget.Global);
    this.log.info('credentials: token cleared from settings.json');
  }

  private warnInsecureFile(path: string): void {
    if (this.insecureWarned.has(path)) {
      return;
    }
    this.insecureWarned.add(path);
    this.log.warn(`credentials: ${path} is readable by group or others`);
    void vscode.window.showWarningMessage(
      `${path} is readable by other users on this machine. Consider restricting it to your account.`,
    );
  }

  private settingToken(): string {
    return vscode.workspace.getConfiguration(SECTION).get<string>('apiToken', '');
  }

  private pathSetting(key: 'tokenFilePath' | 'clientIdFilePath', fileName: string): string {
    const configured = vscode.workspace.getConfiguration(SECTION).get<string>(key, '').trim();
    if (configured !== '') {
      return configured;
    }
    return defaultCredentialPath(fileName, {
      platform: process.platform,
      env: process.env,
      homedir: homedir(),
    });
  }

  /**
   * Watches the directories holding the credential files, not the files
   * themselves: the interesting event is a file being *created* by whatever
   * provisions it, and a path that does not exist yet cannot be watched.
   */
  private watchCredentialFiles(...paths: string[]): void {
    const directories = [...new Set(paths.map((path) => dirname(path)))].sort();
    const key = directories.join(' ');
    if (key === this.watchedKey) {
      return;
    }
    this.stopWatching();

    const names = new Set(paths.map((path) => path.slice(dirname(path).length + 1)));
    let watchedAll = true;
    for (const directory of directories) {
      try {
        const watcher = watch(directory, (_event, filename) => {
          if (filename === null || names.has(filename.toString())) {
            this.log.debug(`credentials: ${directory} changed`);
            this.invalidate();
          }
        });
        // A watch error (directory removed, descriptor limit) must not take the
        // extension down. We stop noticing changes until the next resolve
        // re-establishes the watch.
        watcher.on('error', (error) => this.log.debug('credentials: watch error', error));
        this.watchers.push(watcher);
      } catch {
        // The directory does not exist yet, which is the ordinary state before
        // anything is provisioned. Leave the key unset so the next resolve
        // tries again.
        this.log.debug(`credentials: cannot watch ${directory} yet`);
        watchedAll = false;
      }
    }
    this.watchedKey = watchedAll ? key : '';
  }

  /**
   * The safety net under the watcher.
   *
   * Records each file's mtime and size, and invalidates when either moves. A
   * file appearing counts as a change, which is the provisioning case.
   */
  private startPolling(...paths: string[]): void {
    if (this.pollTimer !== undefined) {
      return;
    }
    // Seeded from the current state, so the first tick reports only real
    // changes rather than everything it sees for the first time.
    void this.captureFingerprints(paths);
    this.pollTimer = setInterval(() => {
      void this.captureFingerprints(paths).then((changed) => {
        if (changed) {
          this.log.debug('credentials: a credential file changed');
          this.invalidate();
        }
      });
    }, this.pollIntervalMs);
  }

  /** Returns true when any fingerprint differs from the last observation. */
  private async captureFingerprints(paths: string[]): Promise<boolean> {
    let changed = false;
    for (const path of paths) {
      let fingerprint = 'absent';
      try {
        const stats = await stat(path);
        fingerprint = `${stats.mtimeMs}:${stats.size}`;
      } catch {
        // Absent is a legitimate observation, not an error: it is the state
        // before provisioning.
      }
      if (this.fingerprints.get(path) !== fingerprint) {
        if (this.fingerprints.has(path)) {
          changed = true;
        }
        this.fingerprints.set(path, fingerprint);
      }
    }
    return changed;
  }

  private stopWatching(): void {
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];
    this.watchedKey = '';
  }
}
