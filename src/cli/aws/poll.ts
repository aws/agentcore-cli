/**
 * Generic polling utility for async AWS resource status transitions.
 */

export interface PollOptions<T> {
  fn: () => Promise<T>;
  isTerminal: (result: T) => boolean;
  isFailure?: (result: T) => boolean;
  getFailureReason?: (result: T) => string;
  intervalMs?: number;
  maxWaitMs?: number;
}

export class PollTimeoutError extends Error {
  constructor(maxWaitMs: number) {
    super(`Polling timed out after ${maxWaitMs}ms`);
    this.name = 'PollTimeoutError';
  }
}

export class PollFailureError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'PollFailureError';
  }
}

export async function pollUntilTerminal<T>(options: PollOptions<T>): Promise<T> {
  const { fn, isTerminal, isFailure, getFailureReason, intervalMs = 3000, maxWaitMs = 120_000 } = options;
  const start = Date.now();

  while (Date.now() - start < maxWaitMs) {
    const result = await fn();

    if (isTerminal(result)) {
      if (isFailure?.(result)) {
        const reason = getFailureReason?.(result) ?? 'Resource entered a failed state';
        throw new PollFailureError(reason);
      }
      return result;
    }

    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }

  throw new PollTimeoutError(maxWaitMs);
}
