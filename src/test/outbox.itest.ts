import * as assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as vscode from 'vscode';
import { AlertService, type Notifier } from '../alerts/alertService';
import { ApiClient } from '../api/client';
import { ConfigService } from '../config';
import { Logger } from '../log';
import { MachineApplyService, type Confirmer } from '../machine/applyService';
import { MachineConfigService } from '../machine/machineConfig';
import { AlertsTreeProvider, PendingAlertItem, RecentFolder } from '../views/alertsTree';
import { removeTree, stopProcess } from './support';

/**
 * Phase 7's acceptance criteria: an answer given while offline arrives exactly
 * once when the network returns, and a configuration apply that failed offline
 * is never replayed.
 *
 * "Offline" here means the client cannot reach the server, simulated by
 * swapping in a client pointed at a dead port. Stopping the mock would also
 * lose its in-memory state, which would test something else.
 */

const HTTP_PORT = 18130;
const GRPC_PORT = 18131;
const BASE_URL = `http://127.0.0.1:${HTTP_PORT}`;
const DEAD_URL = 'http://127.0.0.1:1';
const TOKEN = 'dev-token';
const CLIENT_ID = 'dev-9';
const SECTION = 'acmeAlerts';
const target = vscode.ConfigurationTarget.Global;

suite('Offline resilience', function () {
  this.timeout(120_000);

  let mock: ChildProcess;
  let buildDir: string;
  let configDir: string;
  let log: Logger;
  let tree: AlertsTreeProvider;
  let notifier: RecordingNotifier;
  let memento: MemoryMemento;
  let offline = false;
  let disposables: Array<{ dispose(): void }> = [];

  suiteSetup(async () => {
    const repoRoot = resolve(__dirname, '../../..');
    buildDir = mkdtempSync(join(tmpdir(), 'acme-mock-'));
    // Go does not add .exe when -o names the output, so the test must.
    const binary = join(buildDir, process.platform === 'win32' ? 'mock.exe' : 'mock');
    const built = spawnSync('go', ['build', '-o', binary, './mock'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    assert.equal(built.status, 0, `go build failed: ${built.stderr}`);

    mock = spawn(
      binary,
      [`--http=127.0.0.1:${HTTP_PORT}`, `--grpc=127.0.0.1:${GRPC_PORT}`, '--apply-delay=0'],
      { stdio: 'ignore' },
    );
    await waitForServer();
  });

  suiteTeardown(async () => {
    await stopProcess(mock);
    removeTree(buildDir);
    for (const key of ['serverUrl', 'clientIdFilePath', 'tokenFilePath']) {
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

    offline = false;
    log = new Logger('Acme Alerts Test');
    tree = new AlertsTreeProvider();
    notifier = new RecordingNotifier();
    memento = new MemoryMemento({ 'acmeAlerts.lastSequence': await currentSequence() });
  });

  teardown(async () => {
    for (const disposable of disposables) {
      disposable.dispose();
    }
    disposables = [];
    tree.dispose();
    log.dispose();
    removeTree(configDir);
    await clearServerAlerts();
  });

  function clientFor(): Promise<ApiClient | undefined> {
    return Promise.resolve(
      new ApiClient({
        baseUrl: offline ? DEAD_URL : BASE_URL,
        token: TOKEN,
        clientId: CLIENT_ID,
        clientVersion: '0.1.0',
        timeoutMs: offline ? 1200 : 15_000,
      }),
    );
  }

  function makeAlerts(store: vscode.Memento = memento): AlertService {
    // Holds a watch on the credential directory, so it is disposed with the rest.
    const credentials = new ConfigService(memorySecretStorage(), log);
    disposables.push(credentials);
    const service = new AlertService(
      store,
      log,
      tree,
      credentials,
      clientFor,
      notifier,
      { pollOnly: true, pollWaitSeconds: 1, minIntervalMs: 200, announceDebounceMs: 50 },
    );
    disposables.push(service);
    return service;
  }

  test('an answer given offline is recorded locally and marked as still sending', async () => {
    const alertId = await pushAlert();
    const alerts = makeAlerts();
    await alerts.start();
    await waitUntil(() => pendingItems(tree).length === 1);

    offline = true;
    await alerts.answerWith(alertId, 0);

    // The user's decision is recorded whatever the network did.
    assert.equal(pendingItems(tree).length, 0);
    assert.equal(alerts.hasQueuedAnswers, true);
    assert.equal(alerts.isQueued(alertId), true);

    const recent = tree.getChildren().find((node) => node instanceof RecentFolder);
    assert.match(String(tree.getChildren(recent)[0]?.description), /sending/);

    // ...and the server has not been told yet.
    assert.ok((await pendingOnServer()).includes(alertId));
  });

  test('the queued answer arrives exactly once when the network returns', async () => {
    const alertId = await pushAlert();
    const alerts = makeAlerts();
    await alerts.start();
    await waitUntil(() => pendingItems(tree).length === 1);

    offline = true;
    await alerts.answerWith(alertId, 0);
    assert.ok((await pendingOnServer()).includes(alertId));

    offline = false;
    await alerts.flushOutbox();

    assert.ok(!(await pendingOnServer()).includes(alertId), 'the answer should have been sent');
    assert.equal(alerts.hasQueuedAnswers, false);

    // Flushing again sends nothing: the queue is empty, so there is no second
    // answer to race the first.
    await alerts.flushOutbox();
    assert.equal(alerts.hasQueuedAnswers, false);
  });

  test('a queued answer survives a restart and is sent on the next start', async () => {
    const alertId = await pushAlert();
    const first = makeAlerts();
    await first.start();
    await waitUntil(() => pendingItems(tree).length === 1);

    offline = true;
    await first.answerWith(alertId, 1);
    first.stop();

    // A new service over the same storage, as after a window reload.
    offline = false;
    const second = makeAlerts(memento);
    assert.equal(second.hasQueuedAnswers, true, 'the queue should have been persisted');
    await second.start();

    await waitUntil(async () => !(await pendingOnServer()).includes(alertId));
    assert.equal(second.hasQueuedAnswers, false);
  });

  test('an answer the server refuses is dropped rather than retried forever', async () => {
    const alertId = await pushAlert();
    const alerts = makeAlerts();
    await alerts.start();
    await waitUntil(() => pendingItems(tree).length === 1);

    offline = true;
    await alerts.answerWith(alertId, 0);

    // Withdrawn while the answer sat in the queue. Retrying cannot succeed.
    offline = false;
    await fetch(`${BASE_URL}/admin/alerts/${alertId}/revoke?reason=withdrawn`, { method: 'POST' });
    await alerts.flushOutbox();

    assert.equal(alerts.hasQueuedAnswers, false);
  });

  test('a configuration apply that fails offline is never replayed', async () => {
    const client = new ApiClient({
      baseUrl: BASE_URL,
      token: TOKEN,
      clientId: CLIENT_ID,
      clientVersion: '0.1.0',
    });
    const config = new MachineConfigService(new MemoryMemento(), log, clientFor);
    const confirmer = new AlwaysConfirm();
    const apply = new MachineApplyService(config, log, clientFor, confirmer, 500);
    disposables.push(config, apply);
    await config.refresh();

    const before = await client.getMachineConfig();
    const state = config.current;
    assert.equal(state.kind, 'ready');
    if (state.kind !== 'ready' || !state.config.current) {
      assert.fail('expected a current configuration');
    }

    offline = true;
    const result = await apply.apply({ ...state.config.current, cpuCores: 96 });
    assert.equal(result.ok, false);

    // Back online, and given every opportunity to replay: nothing does.
    // Replaying a reboot after the user has moved on is the opposite of what
    // durable retry is for (design section 9.1).
    offline = false;
    await new Promise((r) => setTimeout(r, 1500));
    await config.refresh();

    const after = await client.getMachineConfig();
    assert.equal(after.version, before.version);
    assert.equal(after.current?.cpuCores, before.current?.cpuCores);
    assert.equal(config.pendingChange, undefined);
  });
});

function pendingItems(tree: AlertsTreeProvider): PendingAlertItem[] {
  return tree
    .getChildren()
    .filter((node): node is PendingAlertItem => node instanceof PendingAlertItem);
}

class RecordingNotifier implements Notifier {
  readonly shown: Array<{ text: string }> = [];
  show(
    _severity: string,
    text: string,
    _options: vscode.MessageOptions,
    _buttons: string[],
  ): Thenable<string | undefined> {
    this.shown.push({ text });
    return Promise.resolve(undefined);
  }
}

class AlwaysConfirm implements Confirmer {
  async confirm(): Promise<boolean> {
    return true;
  }
  async info(): Promise<string | undefined> {
    return undefined;
  }
  async error(): Promise<void> {
    // Reported to the user in production; silent here.
  }
}

class MemoryMemento implements vscode.Memento {
  private readonly store: Map<string, unknown>;
  constructor(initial: Record<string, unknown> = {}) {
    this.store = new Map(Object.entries(initial));
  }
  keys(): readonly string[] {
    return [...this.store.keys()];
  }
  get<T>(key: string, fallback?: T): T | undefined {
    return (this.store.get(key) as T | undefined) ?? fallback;
  }
  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) {
      this.store.delete(key);
      return;
    }
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
      message: 'build is waiting for your approval.',
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

async function currentSequence(): Promise<string> {
  const response = await fetch(`${BASE_URL}/api/v1/alerts:pending?clientId=${CLIENT_ID}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const body = (await response.json()) as { sequence?: string };
  return body.sequence ?? '0';
}

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
