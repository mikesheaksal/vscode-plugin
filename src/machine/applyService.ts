import * as vscode from 'vscode';
import { create } from '@bufbuild/protobuf';
import type { ApiClient } from '../api/client';
import { ApiError, NetworkError } from '../api/errors';
import { ServerClock, confirmationFor, diffRows } from '../core/changePreview';
import type { FieldErrors, MachineSpec } from '../core/machineForm';
import {
  ChangeStatus,
  ResourceSpecSchema,
  type MachineConfigChanged,
} from '../gen/acme/alerts/v1/alerts_pb';
import type { Logger } from '../log';
import type { MachineConfigService } from './machineConfig';

/**
 * The confirmation surface, injectable so the destructive path can be driven in
 * tests. A test cannot click a modal, and what is worth testing is what the
 * dialog says and what each answer does.
 */
export interface Confirmer {
  confirm(message: string, detail: string, confirmLabel: string): Promise<boolean>;
  info(message: string, ...actions: string[]): Promise<string | undefined>;
  error(message: string): Promise<void>;
}

export const vscodeConfirmer: Confirmer = {
  async confirm(message, detail, confirmLabel) {
    const picked = await vscode.window.showWarningMessage(
      message,
      { modal: true, detail },
      confirmLabel,
    );
    return picked === confirmLabel;
  },
  async info(message, ...actions) {
    return vscode.window.showInformationMessage(message, ...actions);
  },
  async error(message) {
    await vscode.window.showErrorMessage(message);
  },
};

/**
 * Applying a configuration to a live machine.
 *
 * The backend applies changes directly, with no approval step, so this is the
 * destructive path: preview to learn the real consequences, confirm, apply,
 * then hold the form read-only until the change completes.
 */
export class MachineApplyService implements vscode.Disposable {
  private readonly clock = new ServerClock();
  private pollTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly config: MachineConfigService,
    private readonly log: Logger,
    private readonly clientFor: () => Promise<ApiClient | undefined>,
    private readonly confirmer: Confirmer = vscodeConfirmer,
    private readonly pollIntervalMs = 15_000,
  ) {}

  /**
   * Previews, confirms, and applies.
   *
   * Returns field errors when the server rejects the spec, so the form can put
   * them beside the inputs they belong to.
   */
  async apply(spec: MachineSpec): Promise<{ ok: boolean; error?: string; fieldErrors?: FieldErrors }> {
    const client = await this.clientFor();
    const state = this.config.current;
    if (!client || state.kind !== 'ready') {
      return { ok: false, error: 'Not connected.' };
    }

    const version = state.config.version;
    const message = create(ResourceSpecSchema, spec);

    // Preview first. The dialog must state real consequences, and only the
    // server knows which changes need a restart. It doubles as pre-flight
    // validation, so the user never confirms something that is then rejected.
    let preview;
    try {
      preview = await client.previewMachineConfig(message, version);
    } catch (error) {
      return this.describeFailure(error, 'check');
    }

    if (!preview.hasChanges) {
      await this.confirmer.info('That is already your machine’s configuration.');
      return { ok: false };
    }

    const rows = diffRows(state.config.current, spec, preview.effects, state.config.gpuTypes);
    const { message: title, detail } = confirmationFor({
      rows,
      requiresRestart: preview.requiresRestart,
      warning: preview.warning,
      cancellationWindowSeconds: preview.cancellationWindowSeconds,
    });

    // Not suppressible: destructive, infrequent, one extra click.
    const confirmed = await this.confirmer.confirm(title, detail, 'Apply changes');
    if (!confirmed) {
      // Cancelling returns to the form with the edits intact. Cancelling is not
      // discarding.
      return { ok: false };
    }

    try {
      const response = await client.applyMachineConfig({
        spec: message,
        expectedVersion: version,
        idempotencyKey: crypto.randomUUID(),
      });
      if (response.serverTime) {
        this.clock.sync(Number(response.serverTime.seconds) * 1000);
      }
      if (response.change) {
        this.config.setPendingChange(response.change, this.clock);
        this.log.info(`Applying change ${response.change.changeId}`);
        this.startPolling();
      }
      return { ok: true };
    } catch (error) {
      return this.describeFailure(error, 'apply');
    }
  }

  /** Aborts a change still inside its cancellation window. */
  async cancel(): Promise<void> {
    const client = await this.clientFor();
    const pending = this.config.pendingChange;
    if (!client || !pending) {
      return;
    }

    try {
      await client.cancelMachineChange(pending.changeId);
      this.log.info(`Cancelled change ${pending.changeId}`);
    } catch (error) {
      if (error instanceof ApiError && error.disposition === 'refresh') {
        // The client renders a countdown but the server decides. Losing this
        // race is a normal outcome, not a failure.
        await this.confirmer.info('Too late to cancel — the change is being applied.');
        return;
      }
      await this.confirmer.error(
        `Could not cancel: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Completion, arriving on the event stream.
   *
   * Failure and cancellation are the same thing to the machine: the server
   * reverts, so there is no partial state to represent and the message can say
   * so plainly.
   */
  async onConfigChanged(event: MachineConfigChanged): Promise<void> {
    this.stopPolling();
    this.config.applyChangedEvent(event);

    const change = event.change;
    if (!change) {
      // Somebody else changed the machine. The form follows along; there is no
      // outcome of ours to report.
      this.log.info('Machine configuration changed elsewhere');
      return;
    }

    switch (change.status) {
      case ChangeStatus.APPLIED: {
        const open = change.url === '' ? undefined : 'Open';
        const picked = await this.confirmer.info(
          'Machine configuration applied.',
          ...(open ? [open] : []),
        );
        if (picked === open && change.url !== '') {
          await vscode.env.openExternal(vscode.Uri.parse(change.url));
        }
        break;
      }
      case ChangeStatus.CANCELLED:
        await this.confirmer.info('Changes cancelled. Your machine is unchanged.');
        break;
      case ChangeStatus.FAILED:
        await this.confirmer.error(
          `Couldn't apply changes. Your machine is unchanged.${
            change.failureReason === '' ? '' : ` ${change.failureReason}`
          }`,
        );
        break;
      default:
        break;
    }
  }

  dispose(): void {
    this.stopPolling();
  }

  /**
   * Fallback for a completion event that never arrives, because the stream is
   * down or buffered. Stops as soon as the change clears.
   */
  private startPolling(): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => {
      if (!this.config.pendingChange) {
        this.stopPolling();
        return;
      }
      void this.config.refresh();
    }, this.pollIntervalMs);
  }

  private stopPolling(): void {
    if (this.pollTimer !== undefined) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private describeFailure(
    error: unknown,
    stage: 'check' | 'apply',
  ): { ok: false; error?: string; fieldErrors?: FieldErrors } {
    if (error instanceof ApiError) {
      if (error.disposition === 'reject') {
        // Field violations arrive keyed by proto path, which is exactly how the
        // form keys its own errors, so they land on the right inputs.
        const fieldErrors: FieldErrors = {};
        for (const violation of error.fieldViolations) {
          fieldErrors[violation.field as keyof FieldErrors] = violation.description;
        }
        return Object.keys(fieldErrors).length > 0
          ? { ok: false, error: error.message, fieldErrors }
          : { ok: false, error: error.message };
      }

      if (error.disposition === 'refresh') {
        // The machine changed under us. Refetch and show what moved rather
        // than overwriting it; the user's edits stay in the form.
        void this.config.refresh();
        return {
          ok: false,
          error: 'Your machine was changed elsewhere. The form has been refreshed — review and apply again.',
        };
      }

      return { ok: false, error: error.message };
    }

    if (error instanceof NetworkError) {
      // Deliberately not queued for later: replaying a reboot once the network
      // returns and the user has moved on is the opposite of what durable
      // retry is for (design section 9.1).
      return {
        ok: false,
        error:
          stage === 'check'
            ? "Couldn't reach the server to check this change."
            : "Couldn't reach the server. Nothing was applied — try again.",
      };
    }

    this.log.error(`Failed to ${stage} machine configuration`, error);
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
