import * as assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as vscode from 'vscode';
import { AlertService, type Notifier } from '../alerts/alertService';
import { ApiClient } from '../api/client';
import { ConfigService } from '../config';
import { Logger } from '../log';
import { AlertsTreeProvider, PendingAlertItem, RecentFolder } from '../views/alertsTree';

/**
 * Phase 4's acceptance criterion, end to end: push an alert at the mock, and
 * the extension shows it, lists it, and records exactly one answer.
 *
 * Everything here is real except the notification surface, which a test cannot
 * click. The mock, the gateway, the HTTP client, the store and the tree are all
 * the production ones.
 */

const HTTP_PORT = 18090;
const GRPC_PORT = 18091;
const BASE_URL = `http://127.0.0.1:${HTTP_PORT}`;
const TOKEN = 'dev-token';
const CLIENT_ID = 'dev-9';
const SECTION = 'acmeAlerts';
const target = vscode.ConfigurationTarget.Global;

suite('Alerts end to end', function () {
  this.timeout(120_000);

  let mock: ChildProcess;
  let buildDir: string;
  let configDir: string;
  let log: Logger;
  let tree: AlertsTreeProvider;
  let service: AlertService;
  let notifier: RecordingNotifier;

  suiteSetup(async () => {
    const repoRoot = resolve(__dirname, '../../..');
    buildDir = mkdtempSync(join(tmpdir(), 'acme-mock-'));
    const binary = join(buildDir, 'mock');
    const built = spawnSync('go', ['build', '-o', binary, './mock'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    assert.equal(built.status, 0, `go build failed: ${built.stderr}`);

    // Spawned directly rather than via `go run`, which leaves its compiled
    // child holding the port when the parent is killed.
    mock = spawn(
      binary,
      [`--http=127.0.0.1:${HTTP_PORT}`, `--grpc=127.0.0.1:${GRPC_PORT}`, '--apply-delay=0'],
      { stdio: 'ignore' },
    );
    await waitForServer();
  });

  suiteTeardown(async () => {
    mock?.kill('SIGKILL');
    rmSync(buildDir, { recursive: true, force: true });
    for (const key of ['serverUrl', 'clientIdFilePath', 'tokenFilePath', 'apiToken']) {
      await vscode.workspace.getConfiguration(SECTION).update(key, undefined, target);
    }
  });

  setup(async () => {
    configDir = mkdtempSync(join(tmpdir(), 'acme-cfg-'));
    writeFileSync(join(configDir, 'client-id'), `${CLIENT_ID}\n`);
    writeFileSync(join(configDir, 'token'), `${TOKEN}\n`);

    const config = vscode.workspace.getConfiguration(SECTION);
    await config.update('serverUrl', BASE_URL, target);
    await config.update('clientIdFilePath', join(configDir, 'client-id'), target);
    await config.update('tokenFilePath', join(configDir, 'token'), target);

    log = new Logger('Acme Alerts Test');
    tree = new AlertsTreeProvider();
    notifier = new RecordingNotifier();
    service = new AlertService(
      new MemoryMemento(),
      log,
      tree,
      new ConfigService(memorySecretStorage(), log),
      async () =>
        new ApiClient({
          baseUrl: BASE_URL,
          token: TOKEN,
          clientId: CLIENT_ID,
          clientVersion: '0.1.0',
        }),
      notifier,
      // A short poll window and a short floor keep the suite quick. Production
      // defaults are 30s and 5s.
      { pollWaitSeconds: 2, minIntervalMs: 250 },
    );
  });

  teardown(async () => {
    service.dispose();
    tree.dispose();
    log.dispose();
    rmSync(configDir, { recursive: true, force: true });
    await clearServerAlerts();
  });

  test('an alert reaches both the notification and the view', async () => {
    const alertId = await pushAlert();
    await service.start();

    await waitUntil(() => notifier.shown.length > 0);
    const shown = notifier.shown[0];
    assert.equal(shown?.severity, 'warning');
    assert.deepEqual(shown?.buttons, ['Approve', 'Reject']);

    const items = tree.getChildren().filter((node) => node instanceof PendingAlertItem);
    assert.equal(items.length, 1);
    assert.equal(items[0]?.alert.alertId, alertId);
    // Two buttons, so the contextValue enables the second inline action.
    assert.equal(items[0]?.contextValue, 'acmeAlert:2');
  });

  test('answering from the notification records exactly one response', async () => {
    const alertId = await pushAlert();
    notifier.answerWith = 'Approve';
    await service.start();

    await waitUntil(async () => (await pendingOnServer()).length === 0);

    // The alert leaves the pending list and appears under Recent with the
    // chosen label.
    const nodes = tree.getChildren();
    assert.equal(nodes.filter((node) => node instanceof PendingAlertItem).length, 0);
    const recent = nodes.find((node) => node instanceof RecentFolder);
    assert.ok(recent, 'expected a Recent folder');
    const answered = tree.getChildren(recent);
    assert.equal(answered.length, 1);
    assert.equal(answered[0]?.description, 'Approve');
    assert.ok(!(await pendingOnServer()).includes(alertId));
  });

  test('answering from an inline action records the same way', async () => {
    await pushAlert();
    // No answer from the notification: this is the one-click path in the view.
    await service.start();
    await waitUntil(() => tree.getChildren().some((node) => node instanceof PendingAlertItem));

    const item = tree
      .getChildren()
      .find((node): node is PendingAlertItem => node instanceof PendingAlertItem);
    assert.ok(item);
    await service.answerWith(item.alert.alertId, 1);

    assert.deepEqual(await pendingOnServer(), []);
    const recent = tree.getChildren().find((node) => node instanceof RecentFolder);
    assert.equal(tree.getChildren(recent)[0]?.description, 'Reject');
  });

  test('a redelivered alert is not announced twice', async () => {
    await pushAlert();
    await service.start();
    await waitUntil(() => notifier.shown.length > 0);

    const afterFirst = notifier.shown.length;
    // The poll loop keeps returning the same pending alert; the dedupe set is
    // what stops a notification per poll.
    await waitUntil(async () => (await pendingOnServer()).length === 1);
    await new Promise((r) => setTimeout(r, 1500));

    assert.equal(notifier.shown.length, afterFirst);
  });

  test('a burst collapses into one notification instead of a stack', async () => {
    for (let index = 0; index < 6; index += 1) {
      await pushAlert();
    }
    await service.start();

    await waitUntil(() => notifier.shown.length > 0);
    await new Promise((r) => setTimeout(r, 500));

    assert.equal(notifier.shown.length, 1, 'six alerts should produce one notification');
    assert.match(notifier.shown[0]?.text ?? '', /6 alerts are awaiting/);
    // Every one of them is still individually recoverable from the view.
    assert.equal(
      tree.getChildren().filter((node) => node instanceof PendingAlertItem).length,
      6,
    );
  });

  test('an alert withdrawn on the server leaves the view', async () => {
    const alertId = await pushAlert();
    await service.start();
    await waitUntil(() => tree.getChildren().some((node) => node instanceof PendingAlertItem));

    await fetch(`${BASE_URL}/admin/alerts/${alertId}/revoke?reason=withdrawn`, { method: 'POST' });

    // Reconciliation, not an event: the poll returns a list without it, and the
    // server is authoritative about what is still live.
    await waitUntil(
      () => !tree.getChildren().some((node) => node instanceof PendingAlertItem),
      30_000,
    );
    const recent = tree.getChildren().find((node) => node instanceof RecentFolder);
    assert.equal(tree.getChildren(recent)[0]?.description, 'withdrawn');
  });

  test('answering an already withdrawn alert reports it rather than failing', async () => {
    const alertId = await pushAlert();
    await service.start();
    await waitUntil(() => tree.getChildren().some((node) => node instanceof PendingAlertItem));
    await fetch(`${BASE_URL}/admin/alerts/${alertId}/revoke`, { method: 'POST' });

    // Answering a stale notification is normal, not an error: the notification
    // could not have been closed when the alert was withdrawn.
    await service.answerWith(alertId, 0);
    assert.deepEqual(await pendingOnServer(), []);
  });
});

class RecordingNotifier implements Notifier {
  readonly shown: Array<{ severity: string; text: string; buttons: string[] }> = [];
  /** Label to "click", or undefined to dismiss. */
  answerWith: string | undefined;

  show(
    severity: string,
    text: string,
    _options: vscode.MessageOptions,
    buttons: string[],
  ): Thenable<string | undefined> {
    this.shown.push({ severity, text, buttons });
    return Promise.resolve(
      this.answerWith !== undefined && buttons.includes(this.answerWith)
        ? this.answerWith
        : undefined,
    );
  }
}

class MemoryMemento implements vscode.Memento {
  private readonly store = new Map<string, unknown>();
  keys(): readonly string[] {
    return [...this.store.keys()];
  }
  get<T>(key: string, fallback?: T): T | undefined {
    return (this.store.get(key) as T | undefined) ?? fallback;
  }
  async update(key: string, value: unknown): Promise<void> {
    this.store.set(key, value);
  }
}

function memorySecretStorage(): vscode.SecretStorage {
  const store = new Map<string, string>();
  const emitter = new vscode.EventEmitter<vscode.SecretStorageChangeEvent>();
  return {
    get: async (key) => store.get(key),
    store: async (key, value) => {
      store.set(key, value);
      emitter.fire({ key });
    },
    delete: async (key) => {
      store.delete(key);
      emitter.fire({ key });
    },
    keys: async () => [...store.keys()],
    onDidChange: emitter.event,
  };
}

async function pushAlert(): Promise<string> {
  const response = await fetch(`${BASE_URL}/admin/alerts`, {
    method: 'POST',
    body: JSON.stringify({
      severity: 'warning',
      title: 'Approval needed',
      message: 'build #4821 is waiting for your approval.',
      buttons: [
        { id: 'approve', label: 'Approve' },
        { id: 'reject', label: 'Reject' },
      ],
    }),
  });
  const body = (await response.json()) as { alertId: string };
  return body.alertId;
}

async function pendingOnServer(): Promise<string[]> {
  const response = await fetch(`${BASE_URL}/api/v1/alerts:pending?clientId=${CLIENT_ID}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const body = (await response.json()) as { alerts?: Array<{ alertId: string }> };
  return (body.alerts ?? []).map((alert) => alert.alertId);
}

/** Leaves the mock with no pending alerts, so each test starts clean. */
async function clearServerAlerts(): Promise<void> {
  for (const alertId of await pendingOnServer()) {
    await fetch(`${BASE_URL}/admin/alerts/${alertId}/revoke?reason=test-cleanup`, {
      method: 'POST',
    });
  }
}

async function waitUntil(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('condition not met before timeout');
}

async function waitForServer(): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE_URL}/api/v1/client?clientId=${CLIENT_ID}`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      if (response.ok) {
        return;
      }
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('mock server did not start');
}
