import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { create } from '@bufbuild/protobuf';
import {
  AlertOutcome,
  ChangeStatus,
  ResourceSpecSchema,
  Severity,
} from '../gen/acme/alerts/v1/alerts_pb';
import { ApiClient } from './client';
import { ApiError, GrpcCode, NetworkError } from './errors';

/**
 * ApiClient against the real Go mock, behind a real grpc-gateway.
 *
 * These are the tests that would have caught the wire-format assumptions the
 * design had to correct: the {"result": ...} stream envelope, uint64 arriving
 * as a JSON string, and absent-vs-zero for optional fields. A hand-written
 * fetch stub would have agreed with whatever the client already believed.
 */

const hasGo = spawnSync('go', ['version'], { stdio: 'ignore' }).status === 0;
const HTTP_PORT = 18080;
const GRPC_PORT = 18081;
const BASE_URL = `http://127.0.0.1:${HTTP_PORT}`;
const TOKEN = 'dev-token';
const CLIENT_ID = 'dev-9';

describe.skipIf(!hasGo)('ApiClient against the Go mock', () => {
  let mock: ChildProcess;
  let buildDir: string;

  beforeAll(async () => {
    // Built and spawned directly rather than run with `go run`: `go run`
    // execs the compiled binary as a child, so killing it leaves the server
    // holding the port, and the next run silently talks to a stale process
    // carrying the previous run's state.
    buildDir = mkdtempSync(join(tmpdir(), 'acme-mock-'));
    const binary = join(buildDir, 'mock');
    const built = spawnSync('go', ['build', '-o', binary, './mock'], { encoding: 'utf8' });
    if (built.status !== 0) {
      throw new Error(`go build failed: ${built.stderr}`);
    }

    mock = spawn(
      binary,
      [`--http=127.0.0.1:${HTTP_PORT}`, `--grpc=127.0.0.1:${GRPC_PORT}`, '--apply-delay=0'],
      { stdio: 'ignore' },
    );
    await waitForServer();
  }, 120_000);

  afterAll(() => {
    mock?.kill('SIGKILL');
    rmSync(buildDir, { recursive: true, force: true });
  });

  function client(overrides: Partial<{ token: string; clientId: string }> = {}): ApiClient {
    return new ApiClient({
      baseUrl: BASE_URL,
      token: overrides.token ?? TOKEN,
      clientId: overrides.clientId ?? CLIENT_ID,
      clientVersion: '0.1.0',
    });
  }

  it('gets client info, and learns the minimum client version', async () => {
    const info = await client().getClientInfo();
    expect(info.clientId).toBe(CLIENT_ID);
    expect(info.minClientVersion).toBe('0.1.0');
    // Timestamps arrive as RFC 3339 and are parsed into the proto type.
    expect(info.serverTime).toBeDefined();
  });

  it('rejects a missing token with UNAUTHENTICATED', async () => {
    const error = await client({ token: '' }).getClientInfo().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe(GrpcCode.Unauthenticated);
    expect((error as ApiError).httpStatus).toBe(401);
    expect((error as ApiError).disposition).toBe('reauthenticate');
  });

  it('rejects a token not paired with the client id, and says so distinctly', async () => {
    // The server-side check the design requires: without it, any valid token
    // could subscribe to another client's alerts.
    const error = await client({ token: 'wrong' }).getClientInfo().catch((e: unknown) => e);
    expect((error as ApiError).code).toBe(GrpcCode.PermissionDenied);
    expect((error as ApiError).disposition).toBe('not-authorized');
  });

  it('reports an unknown client id as NOT_FOUND rather than a permission problem', async () => {
    const error = await client({ clientId: 'nobody' }).getClientInfo().catch((e: unknown) => e);
    expect((error as ApiError).code).toBe(GrpcCode.NotFound);
  });

  it('reads the machine config, catalogue and limits in one call', async () => {
    const config = await client().getMachineConfig();
    expect(config.version).toMatch(/^v\d+$/);
    expect(config.gpuTypes.map((gpu) => gpu.gpuTypeId)).toEqual(['none', 'a100-40', 'h100-80']);
    // Shape rather than exact values: later tests in this file mutate the
    // configuration, and an assertion on a mutable value would make this test
    // depend on its position in the file.
    expect(config.current).toBeDefined();
    expect(config.current?.cpuCores).toBeGreaterThan(0);
    expect(config.limits?.ramGbMax).toBe(2048);
    // maxCount is per type, not a single global maximum.
    expect(config.gpuTypes.find((gpu) => gpu.gpuTypeId === 'h100-80')?.maxCount).toBe(4);
  });

  it('leaves gpuCount genuinely absent for the none type, rather than zero', async () => {
    const config = await client().getMachineConfig();
    const none = config.gpuTypes.find((gpu) => gpu.gpuTypeId === 'none');
    expect(none?.maxCount).toBe(0);

    const preview = await client().previewMachineConfig(
      create(ResourceSpecSchema, { gpuTypeId: 'none', cpuCores: 32, ramGb: 256, ssdGb: 1024 }),
      config.version,
    );
    expect(preview.hasChanges).toBe(true);
  });

  it('rejects gpuCount sent alongside the none type, with the violation on that field', async () => {
    const config = await client().getMachineConfig();
    const error = await client()
      .previewMachineConfig(
        create(ResourceSpecSchema, {
          gpuTypeId: 'none',
          gpuCount: 2,
          cpuCores: 32,
          ramGb: 256,
          ssdGb: 1024,
        }),
        config.version,
      )
      .catch((e: unknown) => e);

    expect((error as ApiError).code).toBe(GrpcCode.InvalidArgument);
    expect((error as ApiError).disposition).toBe('reject');
    expect((error as ApiError).violation('spec.gpu_count')).toBeDefined();
  });

  it('maps an out-of-range value to the field that carries it', async () => {
    const config = await client().getMachineConfig();
    const error = await client()
      .previewMachineConfig(
        create(ResourceSpecSchema, { gpuTypeId: 'none', cpuCores: 32, ramGb: 99_999, ssdGb: 1024 }),
        config.version,
      )
      .catch((e: unknown) => e);
    expect((error as ApiError).violation('spec.ram_gb')?.description).toContain('2048');
  });

  it('attributes a required restart to the field causing it, and omits it otherwise', async () => {
    const config = await client().getMachineConfig();

    const cpuOnly = await client().previewMachineConfig(
      create(ResourceSpecSchema, {
        gpuTypeId: 'a100-40',
        gpuCount: 2,
        cpuCores: 64,
        ramGb: 256,
        ssdGb: 1024,
      }),
      config.version,
    );
    expect(cpuOnly.requiresRestart).toBe(false);
    expect(cpuOnly.effects.map((effect) => effect.fieldPath)).toEqual(['spec.cpu_cores']);

    const gpuSwap = await client().previewMachineConfig(
      create(ResourceSpecSchema, {
        gpuTypeId: 'h100-80',
        gpuCount: 4,
        cpuCores: 32,
        ramGb: 256,
        ssdGb: 1024,
      }),
      config.version,
    );
    expect(gpuSwap.requiresRestart).toBe(true);
    expect(gpuSwap.effects.find((effect) => effect.fieldPath === 'spec.gpu_type_id')?.requiresRestart).toBe(
      true,
    );
    expect(gpuSwap.warning).not.toBe('');
  });

  it('applies a change and advances the config version', async () => {
    const before = await client().getMachineConfig();
    const applied = await client().applyMachineConfig({
      spec: create(ResourceSpecSchema, {
        gpuTypeId: 'a100-40',
        gpuCount: 2,
        cpuCores: 48,
        ramGb: 256,
        ssdGb: 1024,
      }),
      expectedVersion: before.version,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(applied.change?.status).toBe(ChangeStatus.APPLYING);
    expect(applied.serverTime).toBeDefined();

    const after = await client().getMachineConfig();
    expect(after.current?.cpuCores).toBe(48);
    expect(after.version).not.toBe(before.version);
  });

  it('refuses an apply built from a stale version rather than clobbering it', async () => {
    const stale = await client().getMachineConfig();
    await client().applyMachineConfig({
      spec: create(ResourceSpecSchema, {
        gpuTypeId: 'a100-40',
        gpuCount: 2,
        cpuCores: 56,
        ramGb: 256,
        ssdGb: 1024,
      }),
      expectedVersion: stale.version,
      idempotencyKey: crypto.randomUUID(),
    });

    const error = await client()
      .applyMachineConfig({
        spec: create(ResourceSpecSchema, {
          gpuTypeId: 'a100-40',
          gpuCount: 2,
          cpuCores: 8,
          ramGb: 256,
          ssdGb: 1024,
        }),
        expectedVersion: stale.version,
        idempotencyKey: crypto.randomUUID(),
      })
      .catch((e: unknown) => e);

    expect((error as ApiError).code).toBe(GrpcCode.Aborted);
    expect((error as ApiError).httpStatus).toBe(409);
    expect((error as ApiError).disposition).toBe('refresh');
  });

  it('answers an alert, and treats a replayed idempotency key as already recorded', async () => {
    const alertId = await pushAlert();

    const pending = await client().listPendingAlerts();
    expect(pending.alerts.map((alert) => alert.alertId)).toContain(alertId);
    const alert = pending.alerts.find((candidate) => candidate.alertId === alertId);
    expect(alert?.severity).toBe(Severity.WARNING);
    expect(alert?.buttons).toHaveLength(2);
    // uint64 crosses the wire as a JSON string and is parsed back to bigint.
    expect(typeof pending.sequence).toBe('bigint');

    const key = crypto.randomUUID();
    const first = await client().respondToAlert({
      alertId,
      outcome: AlertOutcome.ANSWERED,
      buttonId: 'approve',
      idempotencyKey: key,
    });
    expect(first.recorded).toBe(true);

    const replay = await client().respondToAlert({
      alertId,
      outcome: AlertOutcome.ANSWERED,
      buttonId: 'approve',
      idempotencyKey: key,
    });
    expect(replay.recorded).toBe(false);
  });

  it('rejects a different answer to an already answered alert with ABORTED', async () => {
    const alertId = await pushAlert();
    await client().respondToAlert({
      alertId,
      outcome: AlertOutcome.ANSWERED,
      buttonId: 'approve',
      idempotencyKey: crypto.randomUUID(),
    });

    const error = await client()
      .respondToAlert({
        alertId,
        outcome: AlertOutcome.ANSWERED,
        buttonId: 'reject',
        idempotencyKey: crypto.randomUUID(),
      })
      .catch((e: unknown) => e);
    expect((error as ApiError).code).toBe(GrpcCode.Aborted);
  });

  it('reports a revoked alert as no longer active', async () => {
    const alertId = await pushAlert();
    await fetch(`${BASE_URL}/admin/alerts/${alertId}/revoke?reason=withdrawn`, { method: 'POST' });

    const error = await client()
      .respondToAlert({
        alertId,
        outcome: AlertOutcome.ANSWERED,
        buttonId: 'approve',
        idempotencyKey: crypto.randomUUID(),
      })
      .catch((e: unknown) => e);
    expect((error as ApiError).code).toBe(GrpcCode.FailedPrecondition);
    expect((error as ApiError).disposition).toBe('refresh');
  });

  it('streams NDJSON with a result envelope, not SSE framing', async () => {
    // The correction the design had to make, verified against the real gateway
    // rather than asserted.
    //
    // Subscribing from the current sequence rather than 0, because 0 replays
    // the whole backlog first — which is the resume behaviour, exercised in the
    // next test.
    const { sequence } = await client().listPendingAlerts();
    const controller = new AbortController();
    const response = await fetch(client().eventStreamUrl(sequence), {
      headers: client().headers(),
      signal: controller.signal,
    });
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('content-type')).not.toContain('text/event-stream');
    expect(response.headers.get('x-accel-buffering')).toBe('no');

    const alertId = await pushAlert();
    const line = await readLineMatching(response, controller, (event) => event.alert !== undefined);

    expect(line.raw.startsWith('data:')).toBe(false);
    expect(line.event.alert?.alertId).toBe(alertId);
    // uint64 on the wire is a string, which is what trips people up.
    expect(typeof line.event.sequence).toBe('string');
  }, 20_000);

  it('replays events after lastSequence, so a reconnect leaves no gap', async () => {
    const { sequence: before } = await client().listPendingAlerts();
    // Pushed while nothing is listening: the client was "offline" for this one.
    const missed = await pushAlert();

    const controller = new AbortController();
    const response = await fetch(client().eventStreamUrl(before), {
      headers: client().headers(),
      signal: controller.signal,
    });
    const line = await readLineMatching(response, controller, (event) => event.alert !== undefined);

    expect(line.event.alert?.alertId).toBe(missed);
    expect(BigInt(line.event.sequence ?? '0')).toBeGreaterThan(before);
  }, 20_000);

  it('surfaces an unreachable server as a NetworkError, not an ApiError', async () => {
    const offline = new ApiClient({
      baseUrl: 'http://127.0.0.1:1',
      token: TOKEN,
      clientId: CLIENT_ID,
      clientVersion: '0.1.0',
      timeoutMs: 2000,
    });
    const error = await offline.getClientInfo().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NetworkError);
    expect((error as NetworkError).isAmbiguous).toBe(true);
    expect((error as NetworkError).disposition).toBe('retry');
  });
});

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

interface StreamEvent {
  sequence?: string;
  alert?: { alertId?: string };
  alertRevoked?: { alertId?: string };
  heartbeat?: unknown;
  machineConfigChanged?: unknown;
}

/**
 * Reads NDJSON lines until one unwraps to an event the predicate accepts.
 * Heartbeats and events from earlier tests share the stream, so matching on
 * content rather than position is what keeps this from being order-dependent.
 */
async function readLineMatching(
  response: Response,
  controller: AbortController,
  matches: (event: StreamEvent) => boolean,
  timeoutMs = 10_000,
): Promise<{ raw: string; event: StreamEvent }> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('no response body');
  }
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  let buffer = '';
  try {
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });

      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const raw = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (raw !== '') {
          const parsed = JSON.parse(raw) as { result?: StreamEvent };
          const event = parsed.result;
          if (event && matches(event)) {
            return { raw, event };
          }
        }
        newline = buffer.indexOf('\n');
      }
    }
  } finally {
    controller.abort();
  }
  throw new Error('no matching event arrived on the stream');
}

async function waitForServer(): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE_URL}/api/v1/client?clientId=${CLIENT_ID}`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      if (response.ok) {
        return;
      }
    } catch {
      // Not listening yet; `go run` compiles first.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('mock server did not start');
}
