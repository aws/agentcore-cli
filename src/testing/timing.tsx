export function tick(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class WaitForTimeoutError extends Error {
  constructor() {
    super("waitFor: condition not met before timeout");
    this.name = "WaitForTimeoutError";
  }
}

/**
 * Polls {@link predicate} until it returns true or the timeout elapses,
 * ticking between attempts so pending renders/queries flush.
 *
 * Use instead of a fixed sleep so tests are robust to timing: assert on the
 * outcome, not a delay.
 *
 * @param predicate - Condition to wait for.
 * @param timeoutMs - Maximum time to wait in milliseconds (default 1000).
 * @param intervalMs - Delay between attempts in milliseconds (default 5).
 * @throws If the predicate is not satisfied before the timeout.
 */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 1000,
  intervalMs = 5,
): Promise<void> {
  let waited = 0;
  while (!(await predicate())) {
    if (waited >= timeoutMs) throw new WaitForTimeoutError();
    await tick(intervalMs);
    waited += intervalMs;
  }
}
