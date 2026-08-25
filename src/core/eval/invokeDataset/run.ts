// A failed worker is caught and dropped, not thrown — the caller reports which items failed
// via `failures` (item + error), so it can name them. Bounded concurrency because each item
// invokes a live runtime.
export type ExampleRun<Item, Result> = {
  ok: Result[];
  failures: { item: Item; error: Error }[];
};

export async function runExamples<Item, Result>(
  items: Item[],
  worker: (item: Item) => Promise<Result>,
  concurrency = 5,
): Promise<ExampleRun<Item, Result>> {
  const ok: Result[] = [];
  const failures: { item: Item; error: Error }[] = [];
  let next = 0;
  const run = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next++]!;
      try {
        ok.push(await worker(item));
      } catch (error) {
        failures.push({ item, error: error instanceof Error ? error : new Error(String(error)) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return { ok, failures };
}
