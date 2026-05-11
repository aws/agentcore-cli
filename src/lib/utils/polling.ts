/**
 * Shared polling/retry utility for async operations.
 */

export type PollResult<T> = { done: true; value: T } | { done: false };

export interface PollOptions<T> {
  /** Async function called each iteration. Return {done: true, value} when complete, {done: false} to keep polling. */
  fn: () => Promise<PollResult<T>>;
  /** Max number of attempts before throwing PollExhaustedError. */
  maxAttempts?: number;
  /** Max total time in ms before throwing PollTimeoutError. */
  timeoutMs?: number;
  /** Delay between iterations in ms. Default 5000. */
  delayMs?: number;
  /** Multiply delay by this factor each iteration. Default 1 (fixed). */
  backoffFactor?: number;
  /** Cap on delay in ms. */
  maxDelayMs?: number;
  /** Abort after this many consecutive errors. */
  maxConsecutiveErrors?: number;
  /** Called when fn throws. Return 'retry' to continue or 'abort' to rethrow. Default: 'retry'. */
  onError?: (err: unknown) => 'retry' | 'abort';
}

export class PollTimeoutError extends Error {
  constructor(timeoutMs: number, options?: { cause?: unknown }) {
    super(`Polling timed out after ${timeoutMs}ms`, options);
    this.name = 'PollTimeoutError';
  }
}

export class PollExhaustedError extends Error {
  constructor(maxAttempts: number, options?: { cause?: unknown }) {
    super(`Polling exhausted after ${maxAttempts} attempts`, options);
    this.name = 'PollExhaustedError';
  }
}

export async function poll<T>(options: PollOptions<T>): Promise<T> {
  const {
    fn,
    maxAttempts,
    timeoutMs,
    delayMs = 5000,
    backoffFactor = 1,
    maxDelayMs,
    maxConsecutiveErrors,
    onError,
  } = options;

  if (maxAttempts === undefined && timeoutMs === undefined) {
    throw new Error('poll() requires at least one of maxAttempts or timeoutMs');
  }

  const start = Date.now();
  let attempts = 0;
  let consecutiveErrors = 0;
  let currentDelay = delayMs;
  let lastError: unknown = undefined;

  while (true) {
    if (maxAttempts !== undefined && attempts >= maxAttempts) {
      throw new PollExhaustedError(maxAttempts, { cause: lastError });
    }
    if (timeoutMs !== undefined && Date.now() - start >= timeoutMs) {
      throw new PollTimeoutError(timeoutMs, { cause: lastError });
    }

    attempts++;

    try {
      const result = await fn();
      consecutiveErrors = 0;
      if (result.done) return result.value;
    } catch (err: unknown) {
      const action = onError ? onError(err) : 'retry';
      if (action === 'abort') throw err;
      lastError = err;
      consecutiveErrors++;
      if (maxConsecutiveErrors && consecutiveErrors >= maxConsecutiveErrors) {
        throw new PollExhaustedError(attempts, { cause: lastError });
      }
    }

    // Don't sleep if we're about to exceed timeout
    if (timeoutMs !== undefined && Date.now() - start + currentDelay >= timeoutMs) {
      throw new PollTimeoutError(timeoutMs, { cause: lastError });
    }

    await new Promise(resolve => setTimeout(resolve, currentDelay));
    currentDelay = maxDelayMs ? Math.min(currentDelay * backoffFactor, maxDelayMs) : currentDelay * backoffFactor;
  }
}

/** Check if an error is an AWS throttling/rate-limit error. */
export function isThrottlingError(err: unknown): boolean {
  if (err == null || typeof err !== 'object') return false;
  const name = (err as { name?: string }).name ?? '';
  const message = (err as { message?: string }).message ?? '';
  return (
    name === 'ThrottlingException' ||
    name === 'Throttling' ||
    name === 'TooManyRequestsException' ||
    name === 'RequestLimitExceeded' ||
    message.includes('Rate exceeded') ||
    message.includes('Throttling')
  );
}
