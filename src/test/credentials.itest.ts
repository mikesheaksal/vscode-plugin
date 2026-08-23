import * as assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { ConfigService } from '../config';
import { Logger } from '../log';
import { nodeFiles } from '../nodeFiles';

const SECTION = 'acmeAlerts';
const SECRET_KEY = 'acmeAlerts.apiToken';

/**
 * ConfigService against the real VS Code APIs. The unit tests in
 * src/core/credentials.test.ts drive the resolution rules with a stubbed
 * filesystem; these check the parts only the extension host can answer —
 * that settings round-trip, that SecretStorage actually stores and clears,
 * and that a real file on disk is picked up.
 */
suite('ConfigService', () => {
  let directory: string;
  let secrets: vscode.SecretStorage;
  let log: Logger;
  let services: ConfigService[] = [];

  suiteSetup(async () => {
    const extension = vscode.extensions.getExtension('acme.acme-alerts');
    assert.ok(extension);
    await extension.activate();
    secrets = memorySecretStorage();
  });

  setup(async () => {
    directory = await mkdtemp(join(tmpdir(), 'acme-alerts-'));
    log = new Logger('Acme Alerts Test');
    await config().update('serverUrl', 'https://alerts.example.com', target);
    await config().update('clientIdFilePath', join(directory, 'client-id'), target);
    await config().update('tokenFilePath', join(directory, 'token'), target);
    await config().update('apiToken', undefined, target);
    await secrets.delete(SECRET_KEY);
  });

  teardown(async () => {
    for (const service of services) {
      service.dispose();
    }
    services = [];
    log.dispose();
    await secrets.delete(SECRET_KEY);
    for (const key of ['serverUrl', 'clientIdFilePath', 'tokenFilePath', 'apiToken']) {
      await config().update(key, undefined, target);
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
  });

  test('reports no-server-url before anything is configured', async () => {
    await config().update('serverUrl', undefined, target);
    const state = await make().resolve();
    assert.equal(state.kind, 'no-server-url');
  });

  test('reports no-client-id, naming the path it searched', async () => {
    const state = await make().resolve();
    assert.equal(state.kind, 'no-client-id');
    assert.equal(
      state.kind === 'no-client-id' ? state.searchedPath : undefined,
      join(directory, 'client-id'),
    );
  });

  test('reports signed-out once a client id exists but no token does', async () => {
    await writeFile(join(directory, 'client-id'), 'dev-9\n');
    const state = await make().resolve();
    assert.equal(state.kind, 'signed-out');
  });

  test('resolves a token from secret storage', async () => {
    await writeFile(join(directory, 'client-id'), 'dev-9\n');
    await secrets.store(SECRET_KEY, 'tok-from-secret');

    const state = await make().resolve();
    assert.equal(state.kind, 'ready');
    if (state.kind === 'ready') {
      assert.equal(state.credentials.clientId, 'dev-9');
      assert.equal(state.credentials.token, 'tok-from-secret');
      assert.equal(state.credentials.tokenSource, 'secretStorage');
      assert.equal(state.credentials.serverUrl, 'https://alerts.example.com');
    }
  });

  test('reads both values from a combined credentials file on disk', async () => {
    await writeFile(
      join(directory, 'token'),
      JSON.stringify({ client_id: 'dev-combined', token: 'tok-combined' }),
    );

    const state = await make().resolve();
    assert.equal(state.kind, 'ready');
    if (state.kind === 'ready') {
      assert.equal(state.credentials.clientId, 'dev-combined');
      assert.equal(state.credentials.token, 'tok-combined');
      assert.equal(state.credentials.tokenSource, 'file');
    }
  });

  test('the file watcher picks up a token rotated on disk, with no reload', async () => {
    await writeFile(join(directory, 'client-id'), 'dev-9\n');
    await writeFile(join(directory, 'token'), 'first-token');

    const service = make();
    const before = await service.resolve();
    assert.equal(before.kind === 'ready' ? before.credentials.token : undefined, 'first-token');

    await writeFile(join(directory, 'token'), 'rotated-token');

    // An external tool refreshing the token is picked up without the user
    // reloading the window (design section 6.0). The fs watcher usually does
    // this within milliseconds; the mtime poll behind it guarantees an upper
    // bound on platforms where fs.watch misses the event, which CI showed
    // Windows doing. Hence a window generous enough for the slower path.
    const token = await waitFor(
      async () => {
        const state = await service.resolve();
        return state.kind === 'ready' ? state.credentials.token : undefined;
      },
      'rotated-token',
      20_000,
    );
    assert.equal(token, 'rotated-token');
  });

  test('resolve caches, and invalidate forces a re-read', async () => {
    await writeFile(join(directory, 'client-id'), 'dev-9\n');
    await writeFile(join(directory, 'token'), 'tok');

    // A counting reader rather than a second write: writing would trip the
    // directory watcher and invalidate the cache for us, which is the previous
    // test's subject, not this one's.
    let reads = 0;
    const service = new ConfigService(secrets, log, {
      read: async (path) => {
        reads += 1;
        return nodeFiles.read(path);
      },
    });
    services.push(service);

    await service.resolve();
    const afterFirst = reads;
    await service.resolve();
    assert.equal(reads, afterFirst, 'second resolve should be served from cache');

    // This is what the API client calls on a 401 before retrying: the token
    // file may have been refreshed by an external tool (design section 6.3).
    service.invalidate();
    await service.resolve();
    assert.ok(reads > afterFirst, 'invalidate should force a fresh read');
  });

  test('invalidate fires onDidChange so views can re-render', async () => {
    const service = make();
    let fired = 0;
    service.onDidChange(() => (fired += 1));
    service.invalidate();
    assert.equal(fired, 1);
  });

  test('signOut clears the stored token and returns to signed-out', async () => {
    await writeFile(join(directory, 'client-id'), 'dev-9\n');
    await secrets.store(SECRET_KEY, 'tok-from-secret');

    const service = make();
    assert.equal((await service.resolve()).kind, 'ready');

    await service.signOut();
    assert.equal(await secrets.get(SECRET_KEY), undefined);
    assert.equal((await service.resolve()).kind, 'signed-out');
  });

  test('the token file wins only after settings and secret storage are empty', async () => {
    await writeFile(join(directory, 'client-id'), 'dev-9\n');
    await writeFile(join(directory, 'token'), 'tok-from-file');
    await secrets.store(SECRET_KEY, 'tok-from-secret');

    const withSecret = await make().resolve();
    assert.equal(
      withSecret.kind === 'ready' ? withSecret.credentials.token : undefined,
      'tok-from-secret',
    );

    await secrets.delete(SECRET_KEY);
    const withoutSecret = await make().resolve();
    assert.equal(
      withoutSecret.kind === 'ready' ? withoutSecret.credentials.token : undefined,
      'tok-from-file',
    );
  });

  function make(): ConfigService {
    const service = new ConfigService(secrets, log);
    services.push(service);
    return service;
  }
});

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(SECTION);
}

const target = vscode.ConfigurationTarget.Global;

/** Polls until the value matches, so an asynchronous watch event is not a race. */
async function waitFor<T>(read: () => Promise<T>, expected: T, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let latest = await read();
  while (latest !== expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    latest = await read();
  }
  return latest;
}

/**
 * A faithful stand-in for SecretStorage, rather than the extension's real one.
 *
 * Reaching the real store would mean exporting the extension context purely for
 * tests, which would put every other extension in the window one API call from
 * the user's token. SecretStorage is a three-method key-value API; what these
 * tests need to exercise against the genuine article is the settings and
 * filesystem side, which they do.
 */
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
