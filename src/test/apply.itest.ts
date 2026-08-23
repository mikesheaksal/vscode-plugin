import * as assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as vscode from 'vscode';
import { ApiClient } from '../api/client';
import { NONE_GPU, type MachineSpec } from '../core/machineForm';
import { Logger } from '../log';
import { MachineApplyService, type Confirmer } from '../machine/applyService';
import { MachineConfigService } from '../machine/machineConfig';

/**
 * Phase 6b's acceptance criteria against the real mock.
 *
 * Everything is real except the modal, which a test cannot click: the preview,
 * the apply, the cancellation window, the version precondition and the
 * completion event all go through the gateway.
 */

const HTTP_PORT = 18120;
const GRPC_PORT = 18121;
const BASE_URL = `http://127.0.0.1:${HTTP_PORT}`;
const TOKEN = 'dev-token';
const CLIENT_ID = 'dev-9';
const SECTION = 'acmeAlerts';
const target = vscode.ConfigurationTarget.Global;

suite('Applying a machine configuration', function () {
  this.timeout(120_000);

  let mock: ChildProcess;
  let buildDir: string;
  let binary: string;
  let configDir: string;
  let log: Logger;
  let confirmer: RecordingConfirmer;
  let disposables: Array<{ dispose(): void }> = [];

  suiteSetup(async () => {
    const repoRoot = resolve(__dirname, '../../..');
    buildDir = mkdtempSync(join(tmpdir(), 'acme-mock-'));
    binary = join(buildDir, 'mock');
    const built = spawnSync('go', ['build', '-o', binary, './mock'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    assert.equal(built.status, 0, `go build failed: ${built.stderr}`);
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
    confirmer = new RecordingConfirmer();
  });

  teardown(() => {
    mock?.kill('SIGKILL');
    for (const disposable of disposables) {
      disposable.dispose();
    }
    disposables = [];
    log.dispose();
    rmSync(configDir, { recursive: true, force: true });
  });

  async function start(applyDelay = '0'): Promise<{
    apply: MachineApplyService;
    config: MachineConfigService;
    client: ApiClient;
  }> {
    mock = spawn(
      binary,
      [
        `--http=127.0.0.1:${HTTP_PORT}`,
        `--grpc=127.0.0.1:${GRPC_PORT}`,
        `--apply-delay=${applyDelay}`,
      ],
      { stdio: 'ignore' },
    );
    await waitForServer();

    const client = new ApiClient({
      baseUrl: BASE_URL,
      token: TOKEN,
      clientId: CLIENT_ID,
      clientVersion: '0.1.0',
    });
    const config = new MachineConfigService(new MemoryMemento(), log, async () => client);
    const apply = new MachineApplyService(config, log, async () => client, confirmer, 1000);
    disposables.push(config, apply);
    await config.refresh();
    return { apply, config, client };
  }

  test('previews before confirming, and names the field forcing a restart', async () => {
    const { apply, config } = await start();
    const current = currentSpec(config);
    confirmer.answer = true;

    // A GPU swap needs a restart; the CPU change alongside it does not.
    await apply.apply({ ...current, gpuTypeId: 'h100-80', gpuCount: 4, cpuCores: 64 });

    assert.equal(confirmer.confirmations.length, 1);
    const { detail } = confirmer.confirmations[0]!;
    assert.match(detail, /GPU: .*→.*\(requires a restart\)/);
    assert.match(detail, /CPU cores: 32 → 64/);
    assert.doesNotMatch(detail, /CPU cores: .*requires a restart/);
    assert.match(detail, /This will restart your machine/);
    assert.match(detail, /cancel within 30 seconds/);
  });

  test('omits any mention of restarting when the change does not need one', async () => {
    const { apply, config } = await start();
    confirmer.answer = true;

    await apply.apply({ ...currentSpec(config), cpuCores: 64 });

    const { detail } = confirmer.confirmations[0]!;
    assert.doesNotMatch(detail, /restart/i);
    assert.match(detail, /RAM: 256 GB {2}\(unchanged\)/);
  });

  test('declining the confirmation applies nothing', async () => {
    const { apply, config, client } = await start();
    const before = await client.getMachineConfig();
    confirmer.answer = false;

    const result = await apply.apply({ ...currentSpec(config), cpuCores: 64 });

    assert.equal(result.ok, false);
    const after = await client.getMachineConfig();
    assert.equal(after.version, before.version);
    assert.equal(after.current?.cpuCores, before.current?.cpuCores);
  });

  test('confirming applies the change and the machine ends up reconfigured', async () => {
    const { apply, config, client } = await start();
    confirmer.answer = true;

    const result = await apply.apply({ ...currentSpec(config), cpuCores: 48 });
    assert.equal(result.ok, true);

    const after = await client.getMachineConfig();
    assert.equal(after.current?.cpuCores, 48);
  });

  test('a change in flight is held pending, with a cancellation deadline', async () => {
    const { apply, config } = await start('10s');
    confirmer.answer = true;

    await apply.apply({ ...currentSpec(config), cpuCores: 56 });

    const pending = config.pendingChange;
    assert.ok(pending, 'expected a pending change while it applies');
    assert.ok(pending.cancellableUntilLocalMs, 'expected a cancellation deadline');
    // Roughly the mock's 30s window, expressed against this machine's clock.
    const remaining = pending.cancellableUntilLocalMs - Date.now();
    assert.ok(remaining > 20_000 && remaining <= 31_000, `unexpected window: ${remaining}ms`);
  });

  test('cancelling inside the window reverts, leaving the machine unchanged', async () => {
    const { apply, config, client } = await start('10s');
    const before = await client.getMachineConfig();
    confirmer.answer = true;

    await apply.apply({ ...currentSpec(config), cpuCores: 56 });
    await apply.cancel();

    const after = await client.getMachineConfig();
    assert.equal(after.current?.cpuCores, before.current?.cpuCores);
    assert.equal(after.pendingChange, undefined);
  });

  test('a stale version is refused rather than clobbering a concurrent change', async () => {
    const { apply, config, client } = await start();
    const stale = currentSpec(config);
    confirmer.answer = true;

    // Somebody else changes the machine while the form sits open.
    const server = await client.getMachineConfig();
    await client.applyMachineConfig({
      spec: { ...server.current!, ramGb: 512 },
      expectedVersion: server.version,
      idempotencyKey: crypto.randomUUID(),
    });

    const result = await apply.apply({ ...stale, cpuCores: 64 });

    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /changed elsewhere/i);
    // The concurrent change survives: nothing was overwritten.
    const after = await client.getMachineConfig();
    assert.equal(after.current?.ramGb, 512);
  });

  test('a rejected spec comes back keyed to the field that caused it', async () => {
    const { apply, config } = await start();
    confirmer.answer = true;

    // Past the per-type maximum: the server rejects it at preview time, before
    // anything destructive happens.
    const result = await apply.apply({ ...currentSpec(config), gpuTypeId: 'h100-80', gpuCount: 8 });

    assert.equal(result.ok, false);
    assert.ok(result.fieldErrors, 'expected field errors');
    assert.ok(result.fieldErrors['spec.gpu_count'], 'expected a violation on the gpu count');
    // No dialog: the user never confirms something that is then rejected.
    assert.equal(confirmer.confirmations.length, 0);
  });

  test('a no-op change is reported rather than confirmed', async () => {
    const { apply, config } = await start();
    confirmer.answer = true;

    const result = await apply.apply(currentSpec(config));

    assert.equal(result.ok, false);
    assert.equal(confirmer.confirmations.length, 0);
    assert.match(confirmer.infos.join(' '), /already your machine/i);
  });

  test('a none selection is previewed and applied without a gpu count', async () => {
    const { apply, config, client } = await start();
    confirmer.answer = true;

    const spec: MachineSpec = { ...currentSpec(config), gpuTypeId: NONE_GPU };
    delete spec.gpuCount;
    const result = await apply.apply(spec);

    assert.equal(result.ok, true);
    const after = await client.getMachineConfig();
    assert.equal(after.current?.gpuTypeId, NONE_GPU);
    assert.equal(after.current?.gpuCount, undefined);
  });

  test('an unreachable server reports that nothing was applied', async () => {
    const { config } = await start();
    const offline = new MachineApplyService(
      config,
      log,
      async () =>
        new ApiClient({
          baseUrl: 'http://127.0.0.1:1',
          token: TOKEN,
          clientId: CLIENT_ID,
          clientVersion: '0.1.0',
          timeoutMs: 1500,
        }),
      confirmer,
    );
    disposables.push(offline);
    confirmer.answer = true;

    const result = await offline.apply({ ...currentSpec(config), cpuCores: 64 });

    assert.equal(result.ok, false);
    // Deliberately not queued for later: replaying a reboot after the user has
    // moved on is the opposite of what durable retry is for.
    assert.match(result.error ?? '', /couldn't reach the server/i);
  });

  function currentSpec(config: MachineConfigService): MachineSpec {
    const state = config.current;
    assert.equal(state.kind, 'ready');
    if (state.kind !== 'ready' || !state.config.current) {
      throw new Error('expected a current configuration');
    }
    return { ...state.config.current };
  }
});

class RecordingConfirmer implements Confirmer {
  readonly confirmations: Array<{ message: string; detail: string }> = [];
  readonly infos: string[] = [];
  readonly errors: string[] = [];
  answer = false;

  async confirm(message: string, detail: string): Promise<boolean> {
    this.confirmations.push({ message, detail });
    return this.answer;
  }

  async info(message: string): Promise<string | undefined> {
    this.infos.push(message);
    return undefined;
  }

  async error(message: string): Promise<void> {
    this.errors.push(message);
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
