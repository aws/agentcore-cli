import { describe, expect, test } from "bun:test";
import { testIO } from "../testing";
import {
  applyProgressEvent,
  runWithProgress,
  settleProgress,
  type ProgressEvent,
} from "./progress";

// Ink writes cursor/erase sequences around each frame; the assertions here
// care about frame text, not terminal control. Built without a control-char
// literal so lint stays quiet.
const ANSI_SEQUENCE = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;?]*[A-Za-z]`, "g");

function stripAnsi(text: string): string {
  return text.replace(ANSI_SEQUENCE, "");
}

async function* scripted<T>(
  events: ProgressEvent[],
  outcome: { result: T } | { failure: Error },
): AsyncGenerator<ProgressEvent, T> {
  yield* events;
  if ("failure" in outcome) throw outcome.failure;
  return outcome.result;
}

describe("runWithProgress plain path (no TTY)", () => {
  test("writes step lines, drops output lines, and resolves the return value", async () => {
    const io = testIO();

    const result = await runWithProgress(
      scripted(
        [
          { type: "step", message: "Step one" },
          { type: "output", line: "noisy detail" },
          { type: "step", message: "Step two" },
        ],
        { result: 7 },
      ),
      { io: io.io },
    );

    expect(result).toBe(7);
    expect(io.stderr()).toBe("Step one\nStep two");
    expect(io.stdout()).toBe("");
  });

  test("rethrows a failure after writing the steps that ran", async () => {
    const io = testIO();
    const failure = new Error("synth exploded");

    await expect(
      runWithProgress(scripted([{ type: "step", message: "Synthesizing" }], { failure }), {
        io: io.io,
      }),
    ).rejects.toBe(failure);
    expect(io.stderr()).toBe("Synthesizing");
  });

  test("interactive: false forces the plain path even on a TTY", async () => {
    const io = testIO({ isTTY: true });

    await runWithProgress(scripted([{ type: "step", message: "Step one" }], { result: null }), {
      io: io.io,
      interactive: false,
    });

    expect(io.stderr()).toBe("Step one");
  });
});

describe("runWithProgress interactive path", () => {
  test("renders every step completed and resolves the return value", async () => {
    const io = testIO({ isTTY: true });

    const result = await runWithProgress(
      scripted(
        [
          { type: "step", message: "Verifying account" },
          { type: "output", line: "identity checked" },
          { type: "step", message: "Deploying stack" },
        ],
        { result: "outputs" },
      ),
      { io: io.io },
    );

    const frames = stripAnsi(io.stderr());
    expect(result).toBe("outputs");
    expect(frames).toContain("✓ Verifying account");
    expect(frames).toContain("✓ Deploying stack");
    // Progress renders on stderr only; stdout stays machine-readable.
    expect(io.stdout()).toBe("");
  });

  test("marks the failing step ✕, keeps its recent tail, and rethrows", async () => {
    const io = testIO({ isTTY: true });
    const failure = new Error("Access Denied");

    await expect(
      runWithProgress(
        scripted<never>(
          [
            { type: "step", message: "Deploying stack" },
            { type: "output", line: "dropped early line" },
            { type: "output", line: "CREATE_FAILED | RuntimeRole" },
            { type: "output", line: "ROLLBACK_IN_PROGRESS" },
          ],
          { failure },
        ),
        { io: io.io, tailLines: 2 },
      ),
    ).rejects.toBe(failure);

    const frames = stripAnsi(io.stderr());
    expect(frames).toContain("✕ Deploying stack");
    expect(frames).toContain("│ CREATE_FAILED | RuntimeRole");
    expect(frames).toContain("│ ROLLBACK_IN_PROGRESS");
    // The final frame honors tailLines; the oldest line has scrolled away.
    const finalFrame = frames.slice(frames.lastIndexOf("✕ Deploying stack"));
    expect(finalFrame).not.toContain("dropped early line");
  });

  test("tolerates output lines that arrive before the first step", async () => {
    const io = testIO({ isTTY: true });

    const result = await runWithProgress(
      scripted(
        [
          { type: "output", line: "orphan line" },
          { type: "step", message: "Only step" },
        ],
        { result: 1 },
      ),
      { io: io.io },
    );

    expect(result).toBe(1);
    expect(stripAnsi(io.stderr())).toContain("✓ Only step");
  });
});

describe("applyProgressEvent / settleProgress", () => {
  test("a step completes the running task and starts the next", () => {
    let tasks = applyProgressEvent([], { type: "step", message: "synth" });
    expect(tasks).toEqual([{ title: "synth", state: "running", tail: [] }]);

    tasks = applyProgressEvent(tasks, { type: "output", line: "one" });
    tasks = applyProgressEvent(tasks, { type: "step", message: "deploy" });
    expect(tasks).toEqual([
      { title: "synth", state: "done", tail: [] },
      { title: "deploy", state: "running", tail: [] },
    ]);
  });

  test("output joins the running task's tail, bounded by tailLines", () => {
    let tasks = applyProgressEvent([], { type: "step", message: "deploy" });
    for (const line of ["a", "b", "c"]) {
      tasks = applyProgressEvent(tasks, { type: "output", line }, 2);
    }
    expect(tasks[0]!.tail).toEqual(["b", "c"]);
  });

  test("output before any step is dropped", () => {
    expect(applyProgressEvent([], { type: "output", line: "stray" })).toEqual([]);
  });

  test("settling keeps the tail on failure and clears it on success", () => {
    let tasks = applyProgressEvent([], { type: "step", message: "deploy" });
    tasks = applyProgressEvent(tasks, { type: "output", line: "boom" });

    expect(settleProgress(tasks, "failed")).toEqual([
      { title: "deploy", state: "failed", tail: ["boom"] },
    ]);
    expect(settleProgress(tasks, "done")).toEqual([{ title: "deploy", state: "done", tail: [] }]);
    expect(settleProgress([], "done")).toEqual([]);
  });
});
