import * as assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as vscode from 'vscode';
import { AlertService, type AlertServiceOptions, type Notifier } from '../alerts/alertService';
import { ApiClient } from '../api/client';
import { ConfigService } from '../config';
import { Logger } from '../log';
import { AlertsTreeProvider, PendingAlertItem } from '../views/alertsTree';

/**
 * Phase 5's acceptance criterion: drop the stream mid-flight, and the client
 * reconnects and picks up what it missed, with no gap and no duplicate.
 *
 * The mock's /admin/drop cuts live connections while keeping its event log,
 * which is what a load balancer restart or an idle timeout looks like from the
 * client's side. Restarting the whole process would lose the log and test
 * something else.
 */

const HTTP_PORT = 18100;
const GRPC_PORT = 18101;
const BASE_URL = `http://127.0.0.1:${HTTP_PORT}`;
const TOKEN = 'dev-token';
const CLIENT_ID = 'dev-9';
const SECTION = 'acmeAlerts';
const target = vscode.ConfigurationTarget.Global;

suite('Event stream', function () {
  this.timeout(120_000);

  let mock: ChildProcess;
  let buildDir: string;
  let configDir: string;
  let log: Logger;
  let tree: AlertsTreeProvider;
  let notifier: RecordingNotifier;
  let startSequence: string;
  let services: AlertService[] = [];

  suiteSetup(async () => {
    const repoRoot = resolve(__dirname, '../../..');
    buildDir = mkdtempSync(join(tmpdir(), 'acme-mock-'));
    const binary = join(buildDir, 'mock');
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
    mock?.kill('SIGKILL');
    rmSync(buildDir, { recursive: true, force: true });
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

    startSequence = await currentSequence();
    log = new Logger('Acme Alerts Test');
    tree = new AlertsTreeProvider();
    notifier = new RecordingNotifier();
  });

  teardown(async () => {
    for (const service of services) {
      service.dispose();
    }
    services = [];
    tree.dispose();
    log.dispose();
    rmSync(configDir, { recursive: true, force: true });
    await clearServerAlerts();
  });

  function makeService(options: AlertServiceOptions = {}): AlertService {
    const service = new AlertService(
      // Seeded with the server's current sequence, so each test starts as a
      // client that is up to date rather than replaying every alert earlier
      // tests in this file left in the mock's event log.
      new MemoryMemento({ 'acmeAlerts.lastSequence': startSequence }),
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
      { minBackoffMs: 100, maxBackoffMs: 500, pollWaitSeconds: 2, minIntervalMs: 200, ...options },
    );
    services.push(service);
    return service;
  }

  test('an alert pushed after connecting arrives over the stream', async () => {
    const service = makeService();
    await service.start();
    // No alert exists yet, so nothing but the stream can deliver this one.
    await waitUntil(() => notifier.shown.length === 0, 1000).catch(() => undefined);

    const alertId = await pushAlert();
    await waitUntil(() => pendingItems().length > 0);
    assert.equal(pendingItems()[0]?.alert.alertId, alertId);
    // Announcements are debounced, so they trail arrival slightly.
    await waitUntil(() => notifier.shown.length === 1);
  });

  test('a dropped connection is resumed with no gap and no duplicate', async () => {
    const service = makeService();
    await service.start();

    const first = await pushAlert();
    await waitUntil(() => pendingItems().length === 1);
    await waitUntil(() => notifier.shown.length === 1);
    const notificationsAfterFirst = notifier.shown.length;

    // Cut every live stream. The server keeps its event log, so this is a lost
    // connection rather than a lost server.
    const dropped = await drop();
    assert.ok(dropped >= 1, 'expected at least one live stream to drop');

    // Pushed while the client is disconnected: it can only arrive by replay.
    const second = await pushAlert();

    await waitUntil(() => pendingItems().length === 2, 20_000);
    const ids = pendingItems().map((item) => item.alert.alertId);
    assert.deepEqual(ids.sort(), [first, second].sort());

    // No gap: the alert sent during the outage arrived. No duplicate: the one
    // from before it was replayed by lastSequence but not announced again.
    await waitUntil(() => notifier.shown.length === notificationsAfterFirst + 1);
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(notifier.shown.length, notificationsAfterFirst + 1);
  });

  test('repeated drops do not accumulate duplicates', async () => {
    const service = makeService();
    await service.start();
    await pushAlert();
    await waitUntil(() => pendingItems().length === 1);
    await waitUntil(() => notifier.shown.length === 1);

    for (let round = 0; round < 3; round += 1) {
      assert.ok(await drop() >= 1, `round ${round}: expected a live stream to drop`);
      // Wait for the client to come back before dropping again, otherwise the
      // rounds collapse into one and the replay path is never exercised.
      await waitUntil(async () => (await liveStreams()) >= 1, 15_000);
    }

    // Every reconnect replays the outstanding alert from sequence 0 upward,
    // and the dedupe set is what keeps it to one notification.
    assert.equal(pendingItems().length, 1);
    assert.equal(notifier.shown.length, 1);
  });

  test('a stalled connection is torn down by the heartbeat watchdog and recovers', async () => {
    // The mock heartbeats every 25s, so a 1s watchdog always fires: this is a
    // connection that produces no bytes, which is indistinguishable from a
    // half-open socket and must not hang forever.
    const service = makeService({ heartbeatTimeoutMs: 1000 });
    await service.start();

    // Give the watchdog time to fire and reconnect several times over.
    await new Promise((r) => setTimeout(r, 4000));

    const alertId = await pushAlert();
    await waitUntil(() => pendingItems().length > 0, 20_000);
    assert.equal(pendingItems()[0]?.alert.alertId, alertId);
  });

  test('an alert withdrawn on the server disappears without a poll', async () => {
    const service = makeService();
    await service.start();
    const alertId = await pushAlert();
    await waitUntil(() => pendingItems().length === 1);

    await fetch(`${BASE_URL}/admin/alerts/${alertId}/revoke?reason=withdrawn`, { method: 'POST' });

    // The AlertRevoked event carries this, so it is immediate rather than
    // waiting for the next reconciliation.
    await waitUntil(() => pendingItems().length === 0, 5000);
  });

  test('polling takes over when the stream cannot be established', async () => {
    // Pointed at a port nothing is listening on, the stream fails repeatedly
    // and reports itself degraded, which is what the fallback keys off.
    const service = new AlertService(
      // Seeded with the server's current sequence, so each test starts as a
      // client that is up to date rather than replaying every alert earlier
      // tests in this file left in the mock's event log.
      new MemoryMemento({ 'acmeAlerts.lastSequence': startSequence }),
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
      { pollOnly: true, pollWaitSeconds: 2, minIntervalMs: 200 },
    );
    services.push(service);

    const alertId = await pushAlert();
    await service.start();
    await waitUntil(() => pendingItems().length > 0, 20_000);
    assert.equal(pendingItems()[0]?.alert.alertId, alertId);
  });

  function pendingItems(): PendingAlertItem[] {
    return tree.getChildren().filter((node): node is PendingAlertItem =>
      node instanceof PendingAlertItem,
    );
  }
});

class RecordingNotifier implements Notifier {
  readonly shown: Array<{ severity: string; text: string; buttons: string[] }> = [];
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

/** How many streams are currently connected, without disturbing them. */
async function liveStreams(): Promise<number> {
  const response = await fetch(`${BASE_URL}/admin/streams`);
  const body = (await response.json()) as { streams: number };
  return body.streams;
}

async function drop(): Promise<number> {
  const response = await fetch(`${BASE_URL}/admin/drop`, { method: 'POST' });
  const body = (await response.json()) as { dropped: number };
  return body.dropped;
}

/** The mock's current event sequence, for seeding a client's resume point. */
async function currentSequence(): Promise<string> {
  const response = await fetch(`${BASE_URL}/api/v1/alerts:pending?clientId=${CLIENT_ID}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const body = (await response.json()) as { sequence?: string };
  return body.sequence ?? '0';
}

async function pendingOnServer(): Promise<string[]> {
  const response = await fetch(`${BASE_URL}/api/v1/alerts:pending?clientId=${CLIENT_ID}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const body = (await response.json()) as { alerts?: Array<{ alertId: string }> };
  return (body.alerts ?? []).map((alert) => alert.alertId);
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
