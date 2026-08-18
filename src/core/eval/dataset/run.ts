// A failed worker is counted and dropped, not thrown — the caller reports all-failed via
// firstError. Bounded concurrency because each item invokes a live runtime.
export type ExampleRun<Result> = { ok: Result[]; failed: number; firstError?: Error };

export async function runExamples<Item, Result>(
  items: Item[],
  worker: (item: Item) => Promise<Result>,
  concurrency = 5,
): Promise<ExampleRun<Result>> {
  const ok: Result[] = [];
  let failed = 0;
  let firstError: Error | undefined;
  let next = 0;
  const run = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next++]!;
      try {
        ok.push(await worker(item));
      } catch (error) {
        failed++;
        if (!firstError) firstError = error instanceof Error ? error : new Error(String(error));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return { ok, failed, firstError };
}
