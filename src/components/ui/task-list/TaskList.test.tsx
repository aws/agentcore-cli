import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import { TaskList, type Task } from "./TaskList";

afterEach(cleanup);

function frameOf(tasks: Task[], tailLines?: number): string {
  const instance = render(<TaskList tasks={tasks} tailLines={tailLines} />);
  const frame = instance.lastFrame() ?? "";
  instance.unmount();
  return frame;
}

describe("TaskList", () => {
  test("marks done, running, and failed tasks with the shared glyphs", () => {
    const frame = frameOf([
      { title: "Verifying AWS account", state: "done", tail: [] },
      { title: "Deploying stack", state: "running", tail: [] },
      { title: "Removing stack", state: "failed", tail: [] },
    ]);

    expect(frame).toContain("✓ Verifying AWS account");
    expect(frame).toContain("✕ Removing stack");
    // The running task renders a spinner frame instead of a completion glyph.
    expect(frame).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Deploying stack/);
  });

  test("shows the tail only under a running task, gutter-prefixed", () => {
    const frame = frameOf([
      { title: "Synthesizing", state: "done", tail: ["stale synth line"] },
      { title: "Deploying", state: "running", tail: ["3/12 | CREATE_IN_PROGRESS"] },
    ]);

    expect(frame).toContain("  │ 3/12 | CREATE_IN_PROGRESS");
    expect(frame).not.toContain("stale synth line");
  });

  test("keeps a failed task's tail visible", () => {
    const frame = frameOf([
      { title: "Deploying", state: "failed", tail: ["CREATE_FAILED | AWS::IAM::Role"] },
    ]);

    expect(frame).toContain("✕ Deploying");
    expect(frame).toContain("  │ CREATE_FAILED | AWS::IAM::Role");
  });

  test("shows only the last tailLines lines", () => {
    const frame = frameOf(
      [{ title: "Deploying", state: "running", tail: ["one", "two", "three"] }],
      2,
    );

    expect(frame).not.toContain("│ one");
    expect(frame).toContain("│ two");
    expect(frame).toContain("│ three");
  });

  test("truncates tail lines to the terminal width", () => {
    const instance = render(<></>);
    Object.defineProperty(instance.stdout, "columns", { configurable: true, value: 24 });
    instance.rerender(
      <TaskList
        tasks={[
          {
            title: "Deploying",
            state: "running",
            tail: ["a very long resource event line that would wrap"],
          },
        ]}
      />,
    );

    const tailLine = (instance.lastFrame() ?? "").split("\n").find((line) => line.includes("│"))!;
    expect(tailLine.length).toBeLessThanOrEqual(24);
    expect(tailLine).toContain("…");
    instance.unmount();
  });
});
