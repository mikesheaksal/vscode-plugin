/**
 * gRPC status codes, and what the client does about each.
 *
 * grpc-gateway maps gRPC statuses onto HTTP, so the client sees both: the HTTP
 * status on the response and the numeric gRPC code in the body. The code is the
 * one to branch on — the HTTP mapping is lossy (INVALID_ARGUMENT and
 * FAILED_PRECONDITION both become 400) and the gRPC code is not.
 *
 * No `vscode` import: this is a plain-Node module so it can be unit-tested
 * without an extension host (design section 4).
 */

/** The subset of google.rpc.Code the client acts on. */
export enum GrpcCode {
  Ok = 0,
  InvalidArgument = 3,
  NotFound = 5,
  PermissionDenied = 7,
  ResourceExhausted = 8,
  FailedPrecondition = 9,
  Aborted = 10,
  Unavailable = 14,
  Unauthenticated = 16,
}

/**
 * What the caller should do next. Deliberately about *behaviour* rather than
 * about the error, so call sites cannot quietly forget a code: adding one to
 * the table below gives it a disposition, and the switch stays exhaustive.
 */
export type Disposition =
  /** The request was wrong. Show it and never retry. */
  | 'reject'
  /** Re-resolve the token once, then retry; on a second failure, prompt. */
  | 'reauthenticate'
  /** Credentials are valid but not for this client id. Prompt, do not retry. */
  | 'not-authorized'
  /** Transient. Back off, and queue in the outbox where the call permits it. */
  | 'retry'
  /** State moved under us. Refresh and show the user what changed. */
  | 'refresh';

export interface FieldViolation {
  /** Proto path, e.g. `spec.ram_gb`, which maps onto a form input. */
  field: string;
  description: string;
}

export class ApiError extends Error {
  constructor(
    readonly code: GrpcCode | number,
    message: string,
    readonly httpStatus: number,
    readonly fieldViolations: FieldViolation[] = [],
    readonly retryAfterSeconds?: number | undefined,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get disposition(): Disposition {
    return dispositionFor(this.code);
  }

  /** True when the failure says nothing about whether the request was applied. */
  get isAmbiguous(): boolean {
    return this.code === GrpcCode.Unavailable;
  }

  violation(field: string): FieldViolation | undefined {
    return this.fieldViolations.find((candidate) => candidate.field === field);
  }
}

/** Raised when the request never reached the server: DNS, TCP, TLS, timeout. */
export class NetworkError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'NetworkError';
  }

  get disposition(): Disposition {
    return 'retry';
  }

  get isAmbiguous(): boolean {
    // The request may have been received and applied before the connection
    // dropped, which is exactly why every mutating call carries an idempotency
    // key.
    return true;
  }
}

export function dispositionFor(code: GrpcCode | number): Disposition {
  switch (code) {
    case GrpcCode.InvalidArgument:
      return 'reject';
    case GrpcCode.Unauthenticated:
      return 'reauthenticate';
    case GrpcCode.PermissionDenied:
      return 'not-authorized';
    case GrpcCode.NotFound:
    case GrpcCode.FailedPrecondition:
    case GrpcCode.Aborted:
      return 'refresh';
    case GrpcCode.ResourceExhausted:
    case GrpcCode.Unavailable:
      return 'retry';
    default:
      // An unmapped code is treated as transient rather than fatal: a server
      // that grows a new status should not brick a client that predates it.
      return 'retry';
  }
}

const BAD_REQUEST_TYPE = 'type.googleapis.com/google.rpc.BadRequest';

/**
 * Parses a grpc-gateway error body into an ApiError.
 *
 * The body is a google.rpc.Status: `{code, message, details}`, where details
 * carry an `@type` discriminator. Anything unrecognised is ignored rather than
 * throwing — a parse failure inside error handling would replace a useful
 * message with a useless one.
 */
export function parseErrorBody(
  body: unknown,
  httpStatus: number,
  retryAfterSeconds?: number,
): ApiError {
  const record = isRecord(body) ? body : {};
  const code = typeof record.code === 'number' ? record.code : inferCode(httpStatus);
  const message =
    typeof record.message === 'string' && record.message !== ''
      ? record.message
      : `Request failed with HTTP ${httpStatus}`;

  const violations: FieldViolation[] = [];
  if (Array.isArray(record.details)) {
    for (const detail of record.details) {
      if (!isRecord(detail) || detail['@type'] !== BAD_REQUEST_TYPE) {
        continue;
      }
      const list = detail.fieldViolations ?? detail.field_violations;
      if (!Array.isArray(list)) {
        continue;
      }
      for (const entry of list) {
        if (isRecord(entry) && typeof entry.field === 'string') {
          violations.push({
            field: entry.field,
            description: typeof entry.description === 'string' ? entry.description : message,
          });
        }
      }
    }
  }

  return new ApiError(code, message, httpStatus, violations, retryAfterSeconds);
}

/** Fallback when a proxy returned an error body the gateway never wrote. */
function inferCode(httpStatus: number): GrpcCode | number {
  switch (httpStatus) {
    case 400:
      return GrpcCode.InvalidArgument;
    case 401:
      return GrpcCode.Unauthenticated;
    case 403:
      return GrpcCode.PermissionDenied;
    case 404:
      return GrpcCode.NotFound;
    case 409:
      return GrpcCode.Aborted;
    case 429:
      return GrpcCode.ResourceExhausted;
    default:
      return GrpcCode.Unavailable;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
