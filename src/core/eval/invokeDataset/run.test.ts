import { describe, expect, test } from "bun:test";
import { runExamples } from "./run";

describe("runExamples", () => {
  test("collects successes in ok and a failing worker in failures, not thrown", async () => {
    const { ok, failures } = await runExamples(["a", "bad", "b"], async (item) => {
      if (item === "bad") throw new Error("boom");
      return item.toUpperCase();
    });
    expect(ok.sort()).toEqual(["A", "B"]);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.item).toBe("bad");
    expect(failures[0]?.error.message).toBe("boom");
  });

  test("carries the original item on each failure so the caller can name it", async () => {
    const { failures } = await runExamples([{ id: "x" }, { id: "y" }], async (item) => {
      throw new Error(`fail ${item.id}`);
    });
    expect(failures.map((f) => f.item.id).sort()).toEqual(["x", "y"]);
  });

  test("runs concurrently but never exceeds the default pool bound of 5", async () => {
    let inFlight = 0;
    let peak = 0;
    await runExamples(
      Array.from({ length: 12 }, (_, i) => i),
      async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return null;
      },
    );
    expect(peak).toBeLessThanOrEqual(5); // default concurrency
    expect(peak).toBeGreaterThanOrEqual(2); // proves it did not run serially
  });

  test("caps the worker count at items.length when fewer than the concurrency", async () => {
    let inFlight = 0;
    let peak = 0;
    await runExamples(
      [1, 2],
      async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return null;
      },
      5,
    );
    expect(peak).toBeLessThanOrEqual(2);
  });
});
