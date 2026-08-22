import * as vscode from 'vscode';
import type { ApiClient } from '../api/client';
import { ApiError } from '../api/errors';
import {
  DEFAULT_LIMITS,
  ensureNoneOption,
  type GpuTypeOption,
  type Limits,
  type MachineSpec,
} from '../core/machineForm';
import type { GetMachineConfigResponse } from '../gen/acme/alerts/v1/alerts_pb';
import type { Logger } from '../log';

const CACHE_KEY = 'acmeAlerts.machineConfig';
const STALE_AFTER_MS = 15 * 60 * 1000;

/** The plain, serialisable form of what the form needs to render. */
export interface MachineConfigSnapshot {
  version: string;
  gpuTypes: GpuTypeOption[];
  current?: MachineSpec | undefined;
  limits: Limits;
  /** Set while a change is being applied; the form renders read-only. */
  pendingChangeId?: string | undefined;
  fetchedAt: string;
}

/**
 * What the form should show right now.
 *
 * A cold start that cannot reach the server is an explicit error state with a
 * retry, not an empty dropdown: a user who fills in a form only to discover it
 * cannot be sent has wasted their time twice (design section 8.4).
 */
export type MachineConfigState =
  | { kind: 'loading' }
  | { kind: 'unconfigured' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; config: MachineConfigSnapshot; stale: boolean };

export class MachineConfigService implements vscode.Disposable {
  private state: MachineConfigState;
  private inFlight: Promise<void> | undefined;

  private readonly emitter = new vscode.EventEmitter<MachineConfigState>();
  readonly onDidChange = this.emitter.event;

  constructor(
    private readonly memento: vscode.Memento,
    private readonly log: Logger,
    private readonly clientFor: () => Promise<ApiClient | undefined>,
  ) {
    const cached = this.memento.get<MachineConfigSnapshot>(CACHE_KEY);
    // Rendering from cache immediately is what makes opening the view feel
    // instant; the refresh below swaps in fresher values when it lands.
    this.state = cached ? { kind: 'ready', config: cached, stale: true } : { kind: 'loading' };
  }

  get current(): MachineConfigState {
    return this.state;
  }

  /** Fetches unless the cache is fresh enough. */
  async ensureFresh(): Promise<void> {
    if (this.state.kind === 'ready' && !this.isStale(this.state.config)) {
      return;
    }
    await this.refresh();
  }

  async refresh(): Promise<void> {
    this.inFlight ??= this.fetch().finally(() => {
      this.inFlight = undefined;
    });
    await this.inFlight;
  }

  dispose(): void {
    this.emitter.dispose();
  }

  private async fetch(): Promise<void> {
    const client = await this.clientFor();
    if (!client) {
      this.setState({ kind: 'unconfigured' });
      return;
    }

    try {
      const response = await client.getMachineConfig();
      const snapshot = toSnapshot(response, this.log);
      await this.memento.update(CACHE_KEY, snapshot);
      this.setState({ kind: 'ready', config: snapshot, stale: false });
      this.log.debug(`Machine config ${snapshot.version} loaded`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.state.kind === 'ready') {
        // Degraded beats blocked: the form stays usable, and expectedVersion
        // makes a stale apply fail safely rather than silently doing the wrong
        // thing. The notice is not cosmetic — the *current values* may be stale
        // too, which is the difference between the user thinking they are
        // editing their machine and knowing they might not be.
        this.log.warn(`Could not refresh machine config: ${message}`);
        this.setState({ kind: 'ready', config: this.state.config, stale: true });
        return;
      }
      this.log.error('Could not load machine config', error);
      this.setState({
        kind: 'error',
        message:
          error instanceof ApiError ? message : "Couldn't reach the server to load GPU types.",
      });
    }
  }

  private isStale(config: MachineConfigSnapshot): boolean {
    return Date.now() - Date.parse(config.fetchedAt) > STALE_AFTER_MS;
  }

  private setState(state: MachineConfigState): void {
    this.state = state;
    this.emitter.fire(state);
  }
}

function toSnapshot(response: GetMachineConfigResponse, log: Logger): MachineConfigSnapshot {
  const { options, synthesized } = ensureNoneOption(
    response.gpuTypes.map((gpu) => ({
      gpuTypeId: gpu.gpuTypeId,
      label: gpu.label,
      maxCount: gpu.maxCount,
    })),
  );
  if (synthesized) {
    log.warn('Server catalogue omitted the "none" GPU type; one was synthesised.');
  }

  return {
    version: response.version,
    // Order is the backend's to decide; the client does not re-sort.
    gpuTypes: options,
    current: response.current
      ? {
          gpuTypeId: response.current.gpuTypeId,
          gpuCount: response.current.gpuCount,
          cpuCores: response.current.cpuCores,
          ramGb: response.current.ramGb,
          ssdGb: response.current.ssdGb,
        }
      : undefined,
    limits: response.limits
      ? {
          gpuCountMin: response.limits.gpuCountMin || DEFAULT_LIMITS.gpuCountMin,
          gpuCountMax: response.limits.gpuCountMax || DEFAULT_LIMITS.gpuCountMax,
          cpuCoresMin: response.limits.cpuCoresMin || DEFAULT_LIMITS.cpuCoresMin,
          cpuCoresMax: response.limits.cpuCoresMax || DEFAULT_LIMITS.cpuCoresMax,
          ramGbMin: response.limits.ramGbMin || DEFAULT_LIMITS.ramGbMin,
          ramGbMax: response.limits.ramGbMax || DEFAULT_LIMITS.ramGbMax,
          ssdGbMin: response.limits.ssdGbMin || DEFAULT_LIMITS.ssdGbMin,
          ssdGbMax: response.limits.ssdGbMax || DEFAULT_LIMITS.ssdGbMax,
        }
      : DEFAULT_LIMITS,
    pendingChangeId: response.pendingChange?.changeId,
    fetchedAt: new Date().toISOString(),
  };
}
