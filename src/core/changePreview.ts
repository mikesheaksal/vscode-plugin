/**
 * Building the confirmation a user sees before their machine is reconfigured.
 *
 * Applying is destructive and has no approval step behind it, so the button is
 * not the point of no return — this dialog is. It must state the real
 * consequences, which only the server can compute (design section 8.7).
 *
 * No `vscode` import: the wording and the arithmetic are worth testing without
 * an extension host.
 */

import { NONE_GPU, type GpuTypeOption, type MachineSpec } from './machineForm';

export interface ChangeEffectInfo {
  fieldPath: string;
  description: string;
  requiresRestart: boolean;
}

export interface ChangeRow {
  label: string;
  before: string;
  after: string;
  changed: boolean;
  /** Attributed to the field, so the dialog can name what forces the restart. */
  requiresRestart: boolean;
}

/**
 * One row per field, changed or not.
 *
 * Unchanged rows are kept rather than hidden: the user should be able to
 * confirm the whole resulting state, not just the delta.
 */
export function diffRows(
  current: MachineSpec | undefined,
  next: MachineSpec,
  effects: ChangeEffectInfo[],
  gpuTypes: GpuTypeOption[],
): ChangeRow[] {
  const restartFor = (path: string): boolean =>
    effects.some((effect) => effect.fieldPath === path && effect.requiresRestart);

  const gpuBefore = current ? describeGpu(current, gpuTypes) : '—';
  const gpuAfter = describeGpu(next, gpuTypes);

  return [
    {
      label: 'GPU',
      before: gpuBefore,
      after: gpuAfter,
      changed: gpuBefore !== gpuAfter,
      requiresRestart: restartFor('spec.gpu_type_id') || restartFor('spec.gpu_count'),
    },
    numericRow('CPU cores', current?.cpuCores, next.cpuCores, '', restartFor('spec.cpu_cores')),
    numericRow('RAM', current?.ramGb, next.ramGb, ' GB', restartFor('spec.ram_gb')),
    numericRow('SSD', current?.ssdGb, next.ssdGb, ' GB', restartFor('spec.ssd_gb')),
  ];
}

export interface ConfirmationOptions {
  rows: ChangeRow[];
  requiresRestart: boolean;
  /** Extra sentence from the server, e.g. about running jobs. */
  warning: string;
  /** Zero when the change cannot be cancelled once started. */
  cancellationWindowSeconds: number;
}

export interface Confirmation {
  message: string;
  detail: string;
}

/**
 * The dialog's text.
 *
 * Rendered as one line per field rather than aligned columns: a modal's detail
 * is drawn in the UI's proportional font, where padded columns do not line up.
 */
export function confirmationFor(options: ConfirmationOptions): Confirmation {
  const lines: string[] = [];

  for (const row of options.rows.filter((row) => row.changed)) {
    const restart = row.requiresRestart ? '  (requires a restart)' : '';
    lines.push(`${row.label}: ${row.before} → ${row.after}${restart}`);
  }

  const unchanged = options.rows.filter((row) => !row.changed);
  if (unchanged.length > 0) {
    lines.push('');
    for (const row of unchanged) {
      lines.push(`${row.label}: ${row.after}  (unchanged)`);
    }
  }

  if (options.requiresRestart) {
    lines.push('');
    lines.push(
      options.warning.trim() === ''
        ? 'This will restart your machine.'
        : `This will restart your machine. ${options.warning.trim()}`,
    );
  }

  if (options.cancellationWindowSeconds > 0) {
    lines.push(
      `You can cancel within ${options.cancellationWindowSeconds} seconds of starting.`,
    );
  }

  return { message: 'Apply these changes to your machine?', detail: lines.join('\n') };
}

/**
 * Tracks the offset between this machine's clock and the server's.
 *
 * The cancellation window is a server deadline. A laptop whose clock is four
 * minutes fast would otherwise show the Cancel button vanishing immediately,
 * and one four minutes slow would show it long after the server stopped
 * accepting cancellations.
 */
export class ServerClock {
  private offsetMs = 0;
  private synced = false;

  /** Records the server's notion of now, as of a local instant. */
  sync(serverTimeMs: number, localNowMs: number = Date.now()): void {
    this.offsetMs = serverTimeMs - localNowMs;
    this.synced = true;
  }

  get isSynced(): boolean {
    return this.synced;
  }

  get skewMs(): number {
    return this.offsetMs;
  }

  /** A server timestamp expressed against this machine's clock. */
  toLocal(serverTimeMs: number): number {
    return serverTimeMs - this.offsetMs;
  }

  /** Milliseconds left before a server deadline, never negative. */
  remainingMs(serverDeadlineMs: number, localNowMs: number = Date.now()): number {
    return Math.max(0, this.toLocal(serverDeadlineMs) - localNowMs);
  }
}

function describeGpu(spec: MachineSpec, gpuTypes: GpuTypeOption[]): string {
  if (spec.gpuTypeId === NONE_GPU) {
    return labelFor(spec.gpuTypeId, gpuTypes);
  }
  const count = spec.gpuCount ?? 0;
  return `${labelFor(spec.gpuTypeId, gpuTypes)} ×${count}`;
}

function labelFor(gpuTypeId: string, gpuTypes: GpuTypeOption[]): string {
  return gpuTypes.find((option) => option.gpuTypeId === gpuTypeId)?.label ?? gpuTypeId;
}

function numericRow(
  label: string,
  before: number | undefined,
  after: number,
  unit: string,
  requiresRestart: boolean,
): ChangeRow {
  return {
    label,
    before: before === undefined ? '—' : `${before}${unit}`,
    after: `${after}${unit}`,
    changed: before !== after,
    requiresRestart,
  };
}
