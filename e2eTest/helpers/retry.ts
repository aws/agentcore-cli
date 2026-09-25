/** An error that `retry` rethrows immediately instead of retrying until the deadline. */
export class NonRetryableError extends Error {}

/** Given an async operation, retries it until success or the timeout expires. */
export async function retry<T>(
  operation: () => Promise<T>,
  timeoutMs = 10_000,
  intervalMs = 250,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (true) {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof NonRetryableError) throw error;
      lastError = error;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw lastError;
      await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, remainingMs)));
    }
  }
}
