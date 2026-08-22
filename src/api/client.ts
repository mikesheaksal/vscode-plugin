import { fromJson, toJson, type DescMessage, type MessageShape } from '@bufbuild/protobuf';
import {
  ApplyMachineConfigResponseSchema,
  CancelMachineChangeResponseSchema,
  GetClientInfoResponseSchema,
  GetMachineConfigResponseSchema,
  ListPendingAlertsResponseSchema,
  PreviewMachineConfigResponseSchema,
  RespondToAlertResponseSchema,
  ResourceSpecSchema,
  type AlertOutcome,
  type ApplyMachineConfigResponse,
  type CancelMachineChangeResponse,
  type GetClientInfoResponse,
  type GetMachineConfigResponse,
  type ListPendingAlertsResponse,
  type PreviewMachineConfigResponse,
  type ResourceSpec,
  type RespondToAlertResponse,
} from '../gen/acme/alerts/v1/alerts_pb';
import { ApiError, NetworkError, parseErrorBody } from './errors';

/**
 * Typed client for the JSON projection grpc-gateway serves.
 *
 * Responses are parsed with the generated schemas rather than cast, so a field
 * the server renames fails here with a clear message instead of surfacing as
 * `undefined` three layers up. That is most of the payoff of generating the
 * client's types from the same proto as the server.
 *
 * No `vscode` import: credentials arrive as plain values, and the extension
 * layer supplies them from ConfigService.
 */

export interface ApiClientOptions {
  baseUrl: string;
  token: string;
  clientId: string;
  clientVersion: string;
  /** Injectable for tests. Defaults to the global fetch. */
  fetch?: typeof globalThis.fetch;
  /** Per-request timeout. Streaming calls are not subject to it. */
  timeoutMs?: number;
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly doFetch: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: ApiClientOptions) {
    // A trailing slash would produce `//api/v1/...`, which some proxies treat
    // as a different path.
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.doFetch = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  get clientId(): string {
    return this.options.clientId;
  }

  async getClientInfo(signal?: AbortSignal): Promise<GetClientInfoResponse> {
    return this.get(GetClientInfoResponseSchema, '/api/v1/client', {}, signal);
  }

  async getMachineConfig(signal?: AbortSignal): Promise<GetMachineConfigResponse> {
    return this.get(GetMachineConfigResponseSchema, '/api/v1/machine/config', {}, signal);
  }

  /**
   * Blocks server-side for up to `waitSeconds`, so the caller's timeout must
   * exceed it or the request aborts before the server answers.
   */
  async listPendingAlerts(waitSeconds = 0, signal?: AbortSignal): Promise<ListPendingAlertsResponse> {
    return this.get(
      ListPendingAlertsResponseSchema,
      '/api/v1/alerts:pending',
      { waitSeconds: String(waitSeconds) },
      signal,
      (waitSeconds + 10) * 1000,
    );
  }

  async respondToAlert(
    request: {
      alertId: string;
      outcome: AlertOutcome;
      buttonId?: string;
      idempotencyKey: string;
    },
    signal?: AbortSignal,
  ): Promise<RespondToAlertResponse> {
    return this.post(
      RespondToAlertResponseSchema,
      `/api/v1/alerts/${encodeURIComponent(request.alertId)}/response`,
      {
        clientId: this.options.clientId,
        outcome: request.outcome,
        buttonId: request.buttonId ?? '',
        respondedAt: new Date().toISOString(),
        idempotencyKey: request.idempotencyKey,
      },
      signal,
    );
  }

  async previewMachineConfig(
    spec: ResourceSpec,
    expectedVersion: string,
    signal?: AbortSignal,
  ): Promise<PreviewMachineConfigResponse> {
    return this.post(
      PreviewMachineConfigResponseSchema,
      '/api/v1/machine/config:preview',
      {
        clientId: this.options.clientId,
        spec: toJson(ResourceSpecSchema, spec),
        expectedVersion,
      },
      signal,
    );
  }

  async applyMachineConfig(
    request: { spec: ResourceSpec; expectedVersion: string; idempotencyKey: string },
    signal?: AbortSignal,
  ): Promise<ApplyMachineConfigResponse> {
    return this.post(
      ApplyMachineConfigResponseSchema,
      '/api/v1/machine/config:apply',
      {
        clientId: this.options.clientId,
        spec: toJson(ResourceSpecSchema, request.spec),
        expectedVersion: request.expectedVersion,
        idempotencyKey: request.idempotencyKey,
        clientVersion: this.options.clientVersion,
      },
      signal,
    );
  }

  async cancelMachineChange(
    changeId: string,
    signal?: AbortSignal,
  ): Promise<CancelMachineChangeResponse> {
    return this.post(
      CancelMachineChangeResponseSchema,
      `/api/v1/machine/changes/${encodeURIComponent(changeId)}:cancel`,
      { clientId: this.options.clientId },
      signal,
    );
  }

  /** URL for the event stream. Phase 5 consumes it; built here so one place owns the routing. */
  eventStreamUrl(lastSequence: bigint | string): string {
    const query = new URLSearchParams({
      clientId: this.options.clientId,
      lastSequence: String(lastSequence),
      clientVersion: this.options.clientVersion,
    });
    return `${this.baseUrl}/api/v1/events?${query.toString()}`;
  }

  headers(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Bearer ${this.options.token}`,
      Accept: 'application/json',
      ...extra,
    };
  }

  private async get<Desc extends DescMessage>(
    schema: Desc,
    path: string,
    query: Record<string, string>,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<MessageShape<Desc>> {
    const params = new URLSearchParams({ clientId: this.options.clientId, ...query });
    return this.send(schema, `${path}?${params.toString()}`, { method: 'GET' }, signal, timeoutMs);
  }

  private async post<Desc extends DescMessage>(
    schema: Desc,
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<MessageShape<Desc>> {
    return this.send(
      schema,
      path,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      signal,
    );
  }

  private async send<Desc extends DescMessage>(
    schema: Desc,
    path: string,
    init: RequestInit,
    signal?: AbortSignal,
    timeoutMs = this.timeoutMs,
  ): Promise<MessageShape<Desc>> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

    let response: Response;
    try {
      response = await this.doFetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: { ...this.headers(), ...(init.headers as Record<string, string> | undefined) },
        signal: combined,
      });
    } catch (cause) {
      // A caller-driven abort is not a network failure and must not be retried
      // as one; the caller already knows it cancelled.
      if (signal?.aborted) {
        throw cause;
      }
      throw new NetworkError(describeNetworkFailure(cause, timeoutMs), cause);
    }

    const text = await response.text();
    const body: unknown = text === '' ? {} : safeParse(text);

    if (!response.ok) {
      throw parseErrorBody(body, response.status, retryAfter(response));
    }

    try {
      return fromJson(schema, body as never, { ignoreUnknownFields: true });
    } catch (cause) {
      // A response that does not match the contract is a server or version
      // problem, not a transient one; saying so beats a generic parse error.
      throw new ApiError(
        0,
        `Server response did not match the expected shape: ${(cause as Error).message}`,
        response.status,
      );
    }
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // A proxy error page rather than a gateway response. Keep a snippet: the
    // first line is usually enough to recognise which proxy produced it.
    return { message: text.slice(0, 200) };
  }
}

function retryAfter(response: Response): number | undefined {
  const header = response.headers.get('retry-after');
  if (header === null) {
    return undefined;
  }
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

function describeNetworkFailure(cause: unknown, timeoutMs: number): string {
  if (cause instanceof Error && cause.name === 'TimeoutError') {
    return `Request timed out after ${timeoutMs}ms`;
  }
  return cause instanceof Error ? cause.message : 'Network request failed';
}
