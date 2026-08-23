import { describe, expect, it } from 'vitest';
import { ServerClock, confirmationFor, diffRows, type ChangeEffectInfo } from './changePreview';
import { NONE_GPU, type GpuTypeOption, type MachineSpec } from './machineForm';

const GPUS: GpuTypeOption[] = [
  { gpuTypeId: NONE_GPU, label: 'No GPU', maxCount: 0 },
  { gpuTypeId: 'a100-40', label: 'NVIDIA A100 40GB', maxCount: 8 },
  { gpuTypeId: 'h100-80', label: 'NVIDIA H100 80GB', maxCount: 4 },
];

const CURRENT: MachineSpec = {
  gpuTypeId: 'a100-40',
  gpuCount: 2,
  cpuCores: 32,
  ramGb: 256,
  ssdGb: 1024,
};

const GPU_RESTART: ChangeEffectInfo[] = [
  { fieldPath: 'spec.gpu_type_id', description: 'Requires a restart', requiresRestart: true },
];

describe('diffRows', () => {
  it('marks only the fields that actually differ', () => {
    const rows = diffRows(CURRENT, { ...CURRENT, cpuCores: 64 }, [], GPUS);
    expect(rows.filter((row) => row.changed).map((row) => row.label)).toEqual(['CPU cores']);
    expect(rows).toHaveLength(4);
  });

  it('keeps unchanged rows, so the whole resulting state is confirmable', () => {
    const rows = diffRows(CURRENT, { ...CURRENT, ramGb: 512 }, [], GPUS);
    expect(rows.find((row) => row.label === 'SSD')).toMatchObject({
      changed: false,
      after: '1024 GB',
    });
  });

  it('renders GPU as a label and a count', () => {
    const rows = diffRows(CURRENT, { ...CURRENT, gpuTypeId: 'h100-80', gpuCount: 4 }, [], GPUS);
    const gpu = rows[0];
    expect(gpu?.before).toBe('NVIDIA A100 40GB ×2');
    expect(gpu?.after).toBe('NVIDIA H100 80GB ×4');
    expect(gpu?.changed).toBe(true);
  });

  it('renders the none type without a count', () => {
    const rows = diffRows(CURRENT, { ...CURRENT, gpuTypeId: NONE_GPU, gpuCount: undefined }, [], GPUS);
    expect(rows[0]?.after).toBe('No GPU');
  });

  it('counts a change of GPU count alone as a GPU change', () => {
    const rows = diffRows(CURRENT, { ...CURRENT, gpuCount: 4 }, [], GPUS);
    expect(rows[0]?.changed).toBe(true);
  });

  it('attributes the restart to the field that causes it', () => {
    // A user who learns the disk increase is free makes different choices from
    // one told only that "this change" needs a reboot.
    const rows = diffRows(
      CURRENT,
      { ...CURRENT, gpuTypeId: 'h100-80', gpuCount: 4, ssdGb: 2048 },
      GPU_RESTART,
      GPUS,
    );
    expect(rows.find((row) => row.label === 'GPU')?.requiresRestart).toBe(true);
    expect(rows.find((row) => row.label === 'SSD')?.requiresRestart).toBe(false);
  });

  it('handles a machine with no current configuration', () => {
    const rows = diffRows(undefined, CURRENT, [], GPUS);
    expect(rows.every((row) => row.changed)).toBe(true);
    expect(rows[1]?.before).toBe('—');
  });
});

describe('confirmationFor', () => {
  const rows = diffRows(
    CURRENT,
    { ...CURRENT, gpuTypeId: 'h100-80', gpuCount: 4, cpuCores: 64 },
    GPU_RESTART,
    GPUS,
  );

  it('leads with the changed fields and names the one forcing a restart', () => {
    const { message, detail } = confirmationFor({
      rows,
      requiresRestart: true,
      warning: 'Running jobs will be terminated.',
      cancellationWindowSeconds: 30,
    });
    expect(message).toMatch(/Apply these changes/);
    expect(detail).toContain('GPU: NVIDIA A100 40GB ×2 → NVIDIA H100 80GB ×4  (requires a restart)');
    expect(detail).toContain('CPU cores: 32 → 64');
    expect(detail).not.toContain('CPU cores: 32 → 64  (requires a restart)');
  });

  it('lists unchanged fields for context', () => {
    const { detail } = confirmationFor({
      rows,
      requiresRestart: true,
      warning: '',
      cancellationWindowSeconds: 30,
    });
    expect(detail).toContain('RAM: 256 GB  (unchanged)');
  });

  it("carries the server's warning verbatim", () => {
    const { detail } = confirmationFor({
      rows,
      requiresRestart: true,
      warning: 'Running jobs will be terminated.',
      cancellationWindowSeconds: 0,
    });
    expect(detail).toContain('This will restart your machine. Running jobs will be terminated.');
  });

  it('says nothing about restarting when nothing requires one', () => {
    // Warning about a reboot that will not happen is how warnings stop being
    // read.
    const cpuOnly = diffRows(CURRENT, { ...CURRENT, cpuCores: 64 }, [], GPUS);
    const { detail } = confirmationFor({
      rows: cpuOnly,
      requiresRestart: false,
      warning: '',
      cancellationWindowSeconds: 30,
    });
    expect(detail).not.toMatch(/restart/i);
  });

  it('states the cancellation window up front, and omits it when there is none', () => {
    // People want to know they have thirty seconds *before* deciding.
    expect(
      confirmationFor({ rows, requiresRestart: false, warning: '', cancellationWindowSeconds: 30 })
        .detail,
    ).toContain('cancel within 30 seconds');
    expect(
      confirmationFor({ rows, requiresRestart: false, warning: '', cancellationWindowSeconds: 0 })
        .detail,
    ).not.toMatch(/cancel within/);
  });
});

describe('ServerClock', () => {
  const serverNow = Date.parse('2026-08-20T12:00:00.000Z');

  it('reports the full window when the clocks agree', () => {
    const clock = new ServerClock();
    clock.sync(serverNow, serverNow);
    expect(clock.remainingMs(serverNow + 30_000, serverNow)).toBe(30_000);
  });

  it('still reports the full window when this machine is four minutes fast', () => {
    // Without correction the deadline would look four minutes in the past and
    // the Cancel button would never appear.
    const localNow = serverNow + 4 * 60_000;
    const clock = new ServerClock();
    clock.sync(serverNow, localNow);
    expect(clock.remainingMs(serverNow + 30_000, localNow)).toBe(30_000);
  });

  it('still reports the full window when this machine is four minutes slow', () => {
    const localNow = serverNow - 4 * 60_000;
    const clock = new ServerClock();
    clock.sync(serverNow, localNow);
    expect(clock.remainingMs(serverNow + 30_000, localNow)).toBe(30_000);
  });

  it('counts down as local time advances', () => {
    const clock = new ServerClock();
    clock.sync(serverNow, serverNow);
    expect(clock.remainingMs(serverNow + 30_000, serverNow + 25_000)).toBe(5_000);
  });

  it('never goes negative once the deadline passes', () => {
    const clock = new ServerClock();
    clock.sync(serverNow, serverNow);
    expect(clock.remainingMs(serverNow + 30_000, serverNow + 60_000)).toBe(0);
  });

  it('is usable before any sync, assuming no skew', () => {
    const clock = new ServerClock();
    expect(clock.isSynced).toBe(false);
    expect(clock.remainingMs(serverNow + 10_000, serverNow)).toBe(10_000);
  });
});
