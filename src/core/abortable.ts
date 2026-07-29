/**
 * Relays `source` while making an in-flight read reject as soon as `signal` aborts.
 *
 * Aborts use `signal.reason` or an `AbortError` fallback. The rejection remains
 * observed when no read is pending, and source cleanup is fire-and-forget because
 * a stalled stream may also stall `iterator.return()`.
 */
export async function* abortable<T>(
  source: AsyncIterable<T>,
  signal: AbortSignal,
): AsyncGenerator<T> {
  let abort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    abort = () =>
      reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
  aborted.catch(() => {});

  const iterator = source[Symbol.asyncIterator]();
  try {
    for (;;) {
      const result = await Promise.race([iterator.next(), aborted]);
      if (result.done) return;
      yield result.value;
    }
  } finally {
    signal.removeEventListener("abort", abort);
    void iterator.return?.()?.catch(() => {});
  }
}
