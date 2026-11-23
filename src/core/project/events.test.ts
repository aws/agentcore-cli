import { describe, expect, test } from "bun:test";
import type { ProjectEvent } from "../../handlers/project/types";
import { withEvents, withOutputEvents } from "./events";

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

describe("withEvents", () => {
  test("yields an event as soon as the work emits it, before the work ends", async () => {
    let finish!: () => void;
    const events = withEvents(async (emit) => {
      emit({ type: "step", message: "downloading box" });
      await new Promise<void>((resolve) => (finish = resolve));
    });

    // The work is still waiting, so the first event arrives without it.
    expect(await events.next()).toEqual({
      done: false,
      value: { type: "step", message: "downloading box" },
    });
    finish();
    expect(await events.next()).toEqual({ done: true, value: undefined });
  });

  test("throws the work's error after the events it emitted first", async () => {
    const seen: ProjectEvent[] = [];
    const failure = new Error("download failed");

    const run = async () => {
      for await (const event of withEvents(async (emit) => {
        emit({ type: "step", message: "downloading box" });
        throw failure;
      })) {
        seen.push(event);
      }
    };

    await expect(run()).rejects.toBe(failure);
    expect(seen).toEqual([{ type: "step", message: "downloading box" }]);
  });
});
