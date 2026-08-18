import { test, expect, describe } from "bun:test";
import { runExamples } from "./run";

describe("runExamples", () => {
  test("isolates a failing worker: it is counted, the rest still run", async () => {
    const { ok, failed, firstError } = await runExamples([1, 2, 3, 4], async (n) => {
      if (n === 2) throw new Error("boom 2");
      return n * 10;
    });
    // The three survivors return; order among them is completion order, so compare as a set.
    expect(new Set(ok)).toEqual(new Set([10, 30, 40]));
    expect(failed).toBe(1);
    expect(firstError?.message).toBe("boom 2");
  });

  test("wraps a non-Error throw as an Error for firstError", async () => {
    const { failed, firstError } = await runExamples([1], async () => {
      throw "just a string";
    });
    expect(failed).toBe(1);
    expect(firstError).toBeInstanceOf(Error);
    expect(firstError?.message).toBe("just a string");
  });

  test("processes every item exactly once", async () => {
    const seen: number[] = [];
    const items = Array.from({ length: 23 }, (_, i) => i);
    const { ok } = await runExamples(items, async (n) => {
      seen.push(n);
      return n;
    });
    expect(ok).toHaveLength(23);
    expect([...seen].sort((a, b) => a - b)).toEqual(items);
  });

  test("never exceeds the concurrency bound", async () => {
    let inFlight = 0;
    let peak = 0;
    await runExamples(
      Array.from({ length: 20 }, (_, i) => i),
      async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight--;
      },
      3,
    );
    expect(peak).toBeLessThanOrEqual(3);
  });

  test("empty input runs no workers and reports nothing invoked", async () => {
    let called = false;
    const { ok, failed, firstError } = await runExamples([], async () => {
      called = true;
    });
    expect(called).toBe(false);
    expect(ok).toEqual([]);
    expect(failed).toBe(0);
    expect(firstError).toBeUndefined();
  });
});
