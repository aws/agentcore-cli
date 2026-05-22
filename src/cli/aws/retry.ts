/**
 * AWS error-retryability helpers.
 *
 * Mirrors the signals the AWS SDK's internal retry middleware uses
 * (@smithy/service-error-classification): name-based throttling/transient
 * sets plus HTTP status fallback. Kept intentionally small — no message
 * matching, no ad-hoc per-service rules.
 */

const THROTTLING_NAME = /^(Throttling|TooManyRequests|RequestLimitExceeded|LimitExceeded)(Exception)?$/i;
const TRANSIENT_NAME = /^(ServiceUnavailable|InternalServer|InternalFailure)(Exception)?$/i;

interface AwsErrorShape {
  name?: string;
  code?: string;
  statusCode?: number;
  $metadata?: { httpStatusCode?: number };
}

/** Returns true if the error is a transient AWS error worth retrying. */
export function isRetryableAwsError(err: unknown): boolean {
  const e = err as AwsErrorShape;
  const name = e.name ?? e.code ?? '';
  if (THROTTLING_NAME.test(name) || TRANSIENT_NAME.test(name)) return true;

  const status = e.statusCode ?? e.$metadata?.httpStatusCode;
  if (status === 429) return true;
  if (status !== undefined && status >= 500 && status < 600) return true;

  return false;
}
