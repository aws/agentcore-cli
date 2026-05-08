import { PollExhaustedError, PollTimeoutError, isThrottlingError, poll } from '../polling.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/* eslint-disable @typescript-eslint/require-await */

describe('poll', () => {
  it('returns immediately on first success', async () => {
    const result = await poll({ fn: async () => ({ done: true, value: 42 }), maxAttempts: 5 });
    expect(result).toBe(42);
  });

  it('polls until success', async () => {
    let count = 0;
    const result = await poll({
      fn: async () => {
        count++;
        return count === 3 ? { done: true, value: 'ok' } : { done: false };
      },
      maxAttempts: 5,
      delayMs: 1,
    });
    expect(result).toBe('ok');
    expect(count).toBe(3);
  });

  it('throws PollExhaustedError when maxAttempts exceeded', async () => {
    await expect(poll({ fn: async () => ({ done: false }), maxAttempts: 3, delayMs: 1 })).rejects.toThrow(
      PollExhaustedError
    );
  });

  it('throws PollTimeoutError when timeout exceeded', async () => {
    await expect(poll({ fn: async () => ({ done: false }), timeoutMs: 50, delayMs: 20 })).rejects.toThrow(
      PollTimeoutError
    );
  });

  describe('backoff', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('applies exponential backoff', async () => {
      let count = 0;
      const promise = poll({
        fn: async () => {
          count++;
          return count === 4 ? { done: true, value: 'done' } : { done: false };
        },
        maxAttempts: 5,
        delayMs: 100,
        backoffFactor: 2,
      });
      await vi.advanceTimersByTimeAsync(100); // 1st delay: 100
      await vi.advanceTimersByTimeAsync(200); // 2nd delay: 200
      await vi.advanceTimersByTimeAsync(400); // 3rd delay: 400
      const result = await promise;
      expect(result).toBe('done');
    });

    it('caps delay at maxDelayMs', async () => {
      let count = 0;
      const promise = poll({
        fn: async () => {
          count++;
          return count === 4 ? { done: true, value: 'done' } : { done: false };
        },
        maxAttempts: 5,
        delayMs: 100,
        backoffFactor: 10,
        maxDelayMs: 500,
      });
      await vi.advanceTimersByTimeAsync(100); // 1st: 100
      await vi.advanceTimersByTimeAsync(500); // 2nd: capped at 500
      await vi.advanceTimersByTimeAsync(500); // 3rd: capped at 500
      const result = await promise;
      expect(result).toBe('done');
    });
  });

  it('retries on error by default', async () => {
    let count = 0;
    const result = await poll({
      fn: async () => {
        count++;
        if (count < 3) throw new Error('transient');
        return { done: true, value: 'ok' };
      },
      maxAttempts: 5,
      delayMs: 1,
    });
    expect(result).toBe('ok');
    expect(count).toBe(3);
  });

  it('aborts on error when onError returns abort', async () => {
    const err = new Error('fatal');
    await expect(
      poll({
        fn: async () => {
          throw err;
        },
        maxAttempts: 5,
        delayMs: 1,
        onError: () => 'abort',
      })
    ).rejects.toThrow('fatal');
  });

  it('throws PollExhaustedError after maxConsecutiveErrors', async () => {
    await expect(
      poll({
        fn: async () => {
          throw new Error('fail');
        },
        maxAttempts: 10,
        delayMs: 1,
        maxConsecutiveErrors: 3,
      })
    ).rejects.toThrow(PollExhaustedError);
  });

  it('PollExhaustedError includes cause with the last error', async () => {
    const err = await poll({
      fn: async () => {
        throw new Error('Rate exceeded');
      },
      maxAttempts: 3,
      delayMs: 1,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PollExhaustedError);
    expect((err as PollExhaustedError).cause).toBeInstanceOf(Error);
    expect(((err as PollExhaustedError).cause as Error).message).toBe('Rate exceeded');
  });

  it('PollTimeoutError includes cause with the last error', async () => {
    const err = await poll({
      fn: async () => {
        throw new Error('service unavailable');
      },
      timeoutMs: 50,
      delayMs: 10,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PollTimeoutError);
    expect((err as PollTimeoutError).cause).toBeInstanceOf(Error);
    expect(((err as PollTimeoutError).cause as Error).message).toBe('service unavailable');
  });

  it('cause is undefined when no errors occurred during polling', async () => {
    const err = await poll({
      fn: async () => ({ done: false }),
      maxAttempts: 2,
      delayMs: 1,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PollExhaustedError);
    expect((err as PollExhaustedError).cause).toBeUndefined();
  });

  it('resets consecutive error count on success', async () => {
    let count = 0;
    const result = await poll({
      fn: async () => {
        count++;
        if (count === 1) throw new Error('err1');
        if (count === 2) throw new Error('err2');
        if (count === 3) return { done: false }; // success resets counter
        if (count === 4) throw new Error('err3');
        if (count === 5) throw new Error('err4');
        return { done: true, value: 'ok' };
      },
      maxAttempts: 10,
      delayMs: 1,
      maxConsecutiveErrors: 3,
    });
    expect(result).toBe('ok');
  });

  it('throws if neither maxAttempts nor timeoutMs provided', async () => {
    await expect(poll({ fn: async () => ({ done: true, value: 1 }) })).rejects.toThrow(
      'poll() requires at least one of maxAttempts or timeoutMs'
    );
  });

  it('supports both maxAttempts and timeoutMs together', async () => {
    // maxAttempts hit first
    await expect(
      poll({ fn: async () => ({ done: false }), maxAttempts: 2, timeoutMs: 10000, delayMs: 1 })
    ).rejects.toThrow(PollExhaustedError);
  });
});

describe('isThrottlingError', () => {
  it('detects ThrottlingException by name', () => {
    expect(isThrottlingError({ name: 'ThrottlingException', message: '' })).toBe(true);
  });

  it('detects Rate exceeded in message', () => {
    expect(isThrottlingError(new Error('Rate exceeded'))).toBe(true);
  });

  it('detects TooManyRequestsException', () => {
    expect(isThrottlingError({ name: 'TooManyRequestsException', message: '' })).toBe(true);
  });

  it('returns false for non-throttle errors', () => {
    expect(isThrottlingError(new Error('Stack not found'))).toBe(false);
  });

  it('returns false for null/undefined', () => {
    expect(isThrottlingError(null)).toBe(false);
    expect(isThrottlingError(undefined)).toBe(false);
  });
});
