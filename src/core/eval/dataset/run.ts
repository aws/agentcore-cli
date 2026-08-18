// runExamples runs `worker` over every item with bounded concurrency. A failed worker
// doesn't sink the run — the failure is counted (so the caller can report on all-failed)
// and its item dropped. Returns ok results + the first error, which the caller surfaces
// to explain a total failure. Generic in the item type; not eval-specific.
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
