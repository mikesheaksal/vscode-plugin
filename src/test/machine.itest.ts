import * as assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as vscode from 'vscode';
import { ApiClient } from '../api/client';
import { NONE_GPU, draftFromSpec, isChanged, validate } from '../core/machineForm';
import { Logger } from '../log';
import { MachineConfigService } from '../machine/machineConfig';

/**
 * Phase 6's acceptance criteria against the real mock.
 *
 * The webview's own rendering is not driven here — a test cannot click a
 * `<select>` inside a VS Code webview — but everything the rendering is derived
 * from is: the fetch, the cache, the failure states, and the shared rules the
 * webview and the extension both use.
 */

const HTTP_PORT = 18110;
const GRPC_PORT = 18111;
const BASE_URL = `http://127.0.0.1:${HTTP_PORT}`;
const TOKEN = 'dev-token';
const CLIENT_ID = 'dev-9';
const SECTION = 'acmeAlerts';
const target = vscode.ConfigurationTarget.Global;

suite('Machine configuration', function () {
  this.timeout(120_000);

  let mock: ChildProcess;
  let buildDir: string;
  let binary: string;
  let configDir: string;
  let log: Logger;
  let services: MachineConfigService[] = [];

  suiteSetup(async () => {
    const repoRoot = resolve(__dirname, '../../..');
    buildDir = mkdtempSync(join(tmpdir(), 'acme-mock-'));
    // Go does not add .exe when -o names the output, so the test must.
    binary = join(buildDir, process.platform === 'win32' ? 'mock.exe' : 'mock');
    const built = spawnSync('go', ['build', '-o', binary, './mock'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    assert.equal(built.status, 0, `go build failed: ${built.stderr}`);
    mock = startMock(binary);
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
    log = new Logger('Acme Alerts Test');
  });

  teardown(() => {
    for (const service of services) {
      service.dispose();
    }
    services = [];
    log.dispose();
    rmSync(configDir, { recursive: true, force: true });
  });

  function makeService(
    memento: vscode.Memento = new MemoryMemento(),
    baseUrl = BASE_URL,
  ): MachineConfigService {
    const service = new MachineConfigService(memento, log, async () =>
      new ApiClient({ baseUrl, token: TOKEN, clientId: CLIENT_ID, clientVersion: '0.1.0' }),
    );
    services.push(service);
    return service;
  }

  test('loads the catalogue, current configuration and limits in one call', async () => {
    const service = makeService();
    await service.refresh();

    const state = service.current;
    assert.equal(state.kind, 'ready');
    if (state.kind !== 'ready') {
      return;
    }
    assert.match(state.config.version, /^v\d+$/);
    assert.deepEqual(
      state.config.gpuTypes.map((gpu) => gpu.gpuTypeId),
      [NONE_GPU, 'a100-40', 'h100-80'],
    );
    assert.ok(state.config.current, 'expected a current configuration to pre-fill from');
    assert.equal(state.config.limits.ramGbMax, 2048);
    // maxCount is per type, which is what the count dropdown is built from.
    assert.equal(state.config.gpuTypes.find((g) => g.gpuTypeId === 'h100-80')?.maxCount, 4);
  });

  test('the form starts pre-filled and reports no change', async () => {
    const service = makeService();
    await service.refresh();
    const state = service.current;
    assert.equal(state.kind, 'ready');
    if (state.kind !== 'ready') {
      return;
    }

    // This is what disables Apply until the user actually changes something.
    const draft = draftFromSpec(state.config.current);
    assert.equal(isChanged(draft, state.config.current), false);
    assert.notEqual(draft.cpuCores, '');

    const edited = { ...draft, cpuCores: String(Number(draft.cpuCores) + 8) };
    assert.equal(isChanged(edited, state.config.current), true);
  });

  test('a validated draft produces a spec the server accepts', async () => {
    const service = makeService();
    await service.refresh();
    const state = service.current;
    if (state.kind !== 'ready') {
      assert.fail('expected ready');
    }

    const draft = { ...draftFromSpec(state.config.current), cpuCores: '48' };
    const { spec, errors } = validate(draft, state.config.gpuTypes, state.config.limits);
    assert.deepEqual(errors, {});
    assert.ok(spec);

    // Round-trips through the real gateway: if the client's idea of a valid
    // spec disagreed with the server's, this is where it would show.
    const client = new ApiClient({
      baseUrl: BASE_URL,
      token: TOKEN,
      clientId: CLIENT_ID,
      clientVersion: '0.1.0',
    });
    const preview = await client.previewMachineConfig(
      { $typeName: 'acme.alerts.v1.ResourceSpec', ...spec } as never,
      state.config.version,
    );
    assert.equal(preview.hasChanges, true);
  });

  test('a none selection omits gpuCount, and the server accepts it', async () => {
    const service = makeService();
    await service.refresh();
    const state = service.current;
    if (state.kind !== 'ready') {
      assert.fail('expected ready');
    }

    const draft = { ...draftFromSpec(state.config.current), gpuTypeId: NONE_GPU };
    const { spec } = validate(draft, state.config.gpuTypes, state.config.limits);
    assert.ok(spec);
    assert.ok(!('gpuCount' in spec) || spec.gpuCount === undefined);

    const client = new ApiClient({
      baseUrl: BASE_URL,
      token: TOKEN,
      clientId: CLIENT_ID,
      clientVersion: '0.1.0',
    });
    const preview = await client.previewMachineConfig(
      { $typeName: 'acme.alerts.v1.ResourceSpec', ...spec } as never,
      state.config.version,
    );
    assert.equal(preview.requiresRestart, true);
  });

  test('a cold start with the server unreachable is an error state, not an empty form', async () => {
    // Nothing cached and nothing reachable: the user must be told, not handed
    // a dropdown with no options in it.
    const service = makeService(new MemoryMemento(), 'http://127.0.0.1:1');
    await service.refresh();

    const state = service.current;
    assert.equal(state.kind, 'error');
    if (state.kind === 'error') {
      assert.match(state.message, /server/i);
    }
  });

  test('a cached configuration keeps the form usable when a refresh fails', async () => {
    const memento = new MemoryMemento();
    const warm = makeService(memento);
    await warm.refresh();
    assert.equal(warm.current.kind, 'ready');

    // Same cache, unreachable server: degraded beats blocked.
    const cold = makeService(memento, 'http://127.0.0.1:1');
    await cold.refresh();

    const state = cold.current;
    assert.equal(state.kind, 'ready');
    if (state.kind === 'ready') {
      assert.equal(state.stale, true, 'a form built from a failed refresh must say so');
      assert.ok(state.config.current);
    }
  });

  test('the cache survives a restart, so opening the view renders immediately', async () => {
    const memento = new MemoryMemento();
    await makeService(memento).refresh();

    // A fresh service over the same storage, as after a window reload.
    const restarted = makeService(memento, 'http://127.0.0.1:1');
    assert.equal(restarted.current.kind, 'ready', 'should render from cache before any fetch');
  });

  test('reports unconfigured rather than failing when there are no credentials', async () => {
    const service = new MachineConfigService(new MemoryMemento(), log, async () => undefined);
    services.push(service);
    await service.refresh();
    assert.equal(service.current.kind, 'unconfigured');
  });

  test('a pending change makes the form read-only', async () => {
    // Restarted with a delay so a change stays APPLYING long enough to observe.
    mock.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 300));
    mock = startMock(binary, '--apply-delay=10s');
    await waitForServer();

    const client = new ApiClient({
      baseUrl: BASE_URL,
      token: TOKEN,
      clientId: CLIENT_ID,
      clientVersion: '0.1.0',
    });
    const before = await client.getMachineConfig();
    await client.applyMachineConfig({
      spec: { ...before.current!, cpuCores: 64 },
      expectedVersion: before.version,
      idempotencyKey: crypto.randomUUID(),
    });

    const service = makeService();
    await service.refresh();
    const state = service.current;
    assert.equal(state.kind, 'ready');
    if (state.kind === 'ready') {
      // The view keys its read-only state off this, so a second change cannot
      // be queued on top of the first.
      assert.ok(state.config.pendingChangeId, 'expected a pending change id');
    }

    mock.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 300));
    mock = startMock(binary);
    await waitForServer();
  });
});

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

function startMock(binary: string, ...extra: string[]): ChildProcess {
  return spawn(
    binary,
    [
      `--http=127.0.0.1:${HTTP_PORT}`,
      `--grpc=127.0.0.1:${GRPC_PORT}`,
      '--apply-delay=0',
      ...extra,
    ],
    { stdio: 'ignore' },
  );
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
