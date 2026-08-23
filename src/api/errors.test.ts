import { describe, expect, it } from 'vitest';
import { ApiError, GrpcCode, NetworkError, dispositionFor, parseErrorBody } from './errors';

describe('dispositionFor', () => {
  // This table is the design's section 5.4 error table, executable. If the
  // documented behaviour for a code changes, this fails rather than drifting.
  it.each([
    [GrpcCode.InvalidArgument, 'reject'],
    [GrpcCode.Unauthenticated, 'reauthenticate'],
    [GrpcCode.PermissionDenied, 'not-authorized'],
    [GrpcCode.NotFound, 'refresh'],
    [GrpcCode.FailedPrecondition, 'refresh'],
    [GrpcCode.Aborted, 'refresh'],
    [GrpcCode.ResourceExhausted, 'retry'],
    [GrpcCode.Unavailable, 'retry'],
  ] as const)('code %i disposes to %s', (code, expected) => {
    expect(dispositionFor(code)).toBe(expected);
  });

  it('treats an unmapped code as transient, so a new server status cannot brick an old client', () => {
    expect(dispositionFor(99)).toBe('retry');
  });
});

describe('parseErrorBody', () => {
  it('reads the gRPC code from the body rather than the HTTP status', () => {
    // INVALID_ARGUMENT and FAILED_PRECONDITION both arrive as HTTP 400, so the
    // body is the only thing that distinguishes them.
    const invalid = parseErrorBody({ code: 3, message: 'bad' }, 400);
    const precondition = parseErrorBody({ code: 9, message: 'stale' }, 400);
    expect(invalid.disposition).toBe('reject');
    expect(precondition.disposition).toBe('refresh');
  });

  it('extracts field violations by proto path', () => {
    const error = parseErrorBody(
      {
        code: 3,
        message: 'must be between 1 GB and 2048 GB',
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.BadRequest',
            fieldViolations: [
              { field: 'spec.ram_gb', description: 'must be between 1 GB and 2048 GB' },
            ],
          },
        ],
      },
      400,
    );
    expect(error.fieldViolations).toHaveLength(1);
    expect(error.violation('spec.ram_gb')?.description).toBe('must be between 1 GB and 2048 GB');
    expect(error.violation('spec.cpu_cores')).toBeUndefined();
  });

  it('accepts snake_case field_violations as well as camelCase', () => {
    const error = parseErrorBody(
      {
        code: 3,
        message: 'bad',
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.BadRequest',
            field_violations: [{ field: 'spec.cpu_cores', description: 'too many' }],
          },
        ],
      },
      400,
    );
    expect(error.violation('spec.cpu_cores')?.description).toBe('too many');
  });

  it('ignores detail types it does not understand', () => {
    const error = parseErrorBody(
      {
        code: 3,
        message: 'bad',
        details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '1s' }],
      },
      400,
    );
    expect(error.fieldViolations).toEqual([]);
    expect(error.message).toBe('bad');
  });

  it('falls back to the HTTP status when a proxy returned a body the gateway never wrote', () => {
    const error = parseErrorBody('<html>502 Bad Gateway</html>', 502);
    expect(error.code).toBe(GrpcCode.Unavailable);
    expect(error.disposition).toBe('retry');
  });

  it.each([
    [401, GrpcCode.Unauthenticated],
    [403, GrpcCode.PermissionDenied],
    [404, GrpcCode.NotFound],
    [409, GrpcCode.Aborted],
    [429, GrpcCode.ResourceExhausted],
  ])('infers a code from HTTP %i when the body carries none', (httpStatus, expected) => {
    expect(parseErrorBody({}, httpStatus).code).toBe(expected);
  });

  it('carries Retry-After through', () => {
    const error = parseErrorBody({ code: 8, message: 'slow down' }, 429, 30);
    expect(error.retryAfterSeconds).toBe(30);
  });
});

describe('ambiguity', () => {
  it('marks a dropped connection ambiguous, because the server may have applied it', () => {
    expect(new NetworkError('socket hang up').isAmbiguous).toBe(true);
  });

  it('does not mark a rejected request ambiguous', () => {
    expect(new ApiError(GrpcCode.InvalidArgument, 'bad', 400).isAmbiguous).toBe(false);
  });
});
