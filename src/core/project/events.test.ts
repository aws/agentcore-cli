import { describe, expect, test } from "bun:test";
import type { ProjectEvent } from "../../handlers/project/types";
import { withOutputEvents } from "./events";

async function collect<T>(
  generator: AsyncGenerator<ProjectEvent, T>,
): Promise<{ events: ProjectEvent[]; result: T }> {
  const events: ProjectEvent[] = [];
  while (true) {
    const next = await generator.next();
    if (next.done) return { events, result: next.value };
    events.push(next.value);
  }
}

describe("withOutputEvents", () => {
  test("yields emitted lines as output events and returns the operation's result", async () => {
    const { events, result } = await collect(
      withOutputEvents(async (emit) => {
        emit("one");
        emit("two");
        return 42;
      }),
    );

    expect(events).toEqual([
      { type: "output", line: "one" },
      { type: "output", line: "two" },
    ]);
    expect(result).toBe(42);
  });

  test("keeps yielding while the operation is still running", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const generator = withOutputEvents(async (emit) => {
      emit("early");
      await gate;
      emit("late");
      return "done";
    });

    expect((await generator.next()).value).toEqual({ type: "output", line: "early" });
    release();
    expect((await generator.next()).value).toEqual({ type: "output", line: "late" });
    const next = await generator.next();
    expect(next.done).toBe(true);
    expect(next.value).toBe("done");
  });

  test("drains pending lines before rethrowing the operation's failure", async () => {
    const failure = new Error("operation exploded");
    const generator = withOutputEvents<void>(async (emit) => {
      emit("last words");
      throw failure;
    });

    const events: ProjectEvent[] = [];
    await expect(
      (async () => {
        for await (const event of generator) events.push(event);
      })(),
    ).rejects.toBe(failure);
    expect(events).toEqual([{ type: "output", line: "last words" }]);
  });
});
