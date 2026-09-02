import { render } from "ink";
import { TaskList, type Task } from "../components/ui/task-list";
import type { AppIO } from "../io";

/**
 * The event vocabulary long-running operations report progress through. A
 * `step` starts a new unit of work and implicitly completes the one before it;
 * an `output` line belongs to the most recent step. The final step completes
 * when the generator returns, and fails when it throws.
 */
export type ProgressEvent = { type: "step"; message: string } | { type: "output"; line: string };

export type RunWithProgressOptions = {
  io: AppIO;
  /** Lines of live output kept under the running step (default 5). */
  tailLines?: number;
  /**
   * Overrides TTY detection: pass false to force the plain line-per-step path
   * (e.g. in --json mode, where stderr may be a TTY but the caller wants no
   * ANSI). Defaults to whether io.stderr is a TTY.
   */
  interactive?: boolean;
};

const DEFAULT_TAIL_LINES = 5;

/**
 * Folds one progress event into a task list: a `step` completes the running
 * task and starts a new one; an `output` line joins the running task's tail.
 * Pure, so every renderer of progress — the inline TaskList below, a TUI
 * screen's running phase — reads events the same way and shows the same steps.
 */
export function applyProgressEvent(
  tasks: readonly Task[],
  event: ProgressEvent,
  tailLines = DEFAULT_TAIL_LINES,
): Task[] {
  const current = tasks[tasks.length - 1];
  if (event.type === "step") {
    const settled = current
      ? [...tasks.slice(0, -1), { ...current, state: "done" as const, tail: [] }]
      : [];
    return [...settled, { title: event.message, state: "running", tail: [] }];
  }
  // An output line before the first step has nowhere to render; the debug log
  // still has it.
  if (!current) return [...tasks];
  return [
    ...tasks.slice(0, -1),
    { ...current, tail: [...current.tail, event.line].slice(-tailLines) },
  ];
}

/**
 * Marks the running task finished: `done` when the generator returned (its
 * tail collapses), `failed` when it threw (the tail stays, so the last output
 * is visible above the error).
 */
export function settleProgress(tasks: readonly Task[], state: "done" | "failed"): Task[] {
  const current = tasks[tasks.length - 1];
  if (!current) return [...tasks];
  return [...tasks.slice(0, -1), { ...current, state, tail: state === "done" ? [] : current.tail }];
}

/**
 * Drains a progress generator, reporting the task list after every change, and
 * resolves with the generator's return value. On failure the running task is
 * marked failed and the error rethrown unchanged. This is the one place a
 * generator becomes tasks; every renderer — the inline TaskList below, a TUI
 * screen — supplies only how to draw them.
 */
export async function driveProgress<T>(
  generator: AsyncGenerator<ProgressEvent, T>,
  onChange: (tasks: Task[]) => void,
  tailLines = DEFAULT_TAIL_LINES,
): Promise<T> {
  let tasks: Task[] = [];
  try {
    let next = await generator.next();
    while (!next.done) {
      tasks = applyProgressEvent(tasks, next.value, tailLines);
      onChange(tasks);
      next = await generator.next();
    }
    onChange(settleProgress(tasks, "done"));
    return next.value;
  } catch (error) {
    onChange(settleProgress(tasks, "failed"));
    throw error;
  }
}

/**
 * Drains a progress generator into a live step list and resolves with the
 * generator's return value.
 *
 * Interactive path (stderr is a TTY): mounts an inline Ink TaskList on
 * io.stderr — normal scrollback, not the alternate screen — with a spinner on
 * the running step and a scrolling tail of its recent output. stdout is never
 * touched, so machine output stays clean. On failure the current step is
 * marked ✕ with its tail left visible in scrollback, and the error is rethrown
 * unchanged for the caller's exit-code handling to print in full.
 *
 * Fallback path (non-TTY or interactive: false): writes each step message as a
 * plain line to stderr and drops output lines (they are in the debug log),
 * matching the pre-TUI behavior byte for byte.
 *
 * Generic over the operation: nothing here knows about deploys. Any command
 * whose work is an AsyncGenerator<ProgressEvent, T> can run under it.
 */
export async function runWithProgress<T>(
  generator: AsyncGenerator<ProgressEvent, T>,
  options: RunWithProgressOptions,
): Promise<T> {
  const interactive = options.interactive ?? options.io.stderr.isTTY === true;
  if (!interactive) {
    let next = await generator.next();
    while (!next.done) {
      if (next.value.type === "step") options.io.stderr.write(`${next.value.message}\n`);
      next = await generator.next();
    }
    return next.value;
  }

  const tailLines = options.tailLines ?? DEFAULT_TAIL_LINES;
  // Ink renders onto its `stdout` option; handing it io.stderr keeps progress
  // off the machine-readable stream, same as the plain path.
  const instance = render(<TaskList tasks={[]} tailLines={tailLines} />, {
    stdout: options.io.stderr,
    stderr: options.io.stderr,
    stdin: options.io.stdin,
    // Nothing here reads input, so stdin stays out of raw mode and Ctrl+C
    // reaches the process as a normal SIGINT; Ink's exit hook restores the
    // cursor on the way down.
    exitOnCtrlC: false,
    patchConsole: false,
  });

  // On failure the failed step keeps its tail: the last frame stays in
  // scrollback above the error message runWithExitCode prints after the rethrow.
  try {
    return await driveProgress(
      generator,
      (tasks) => instance.rerender(<TaskList tasks={tasks} tailLines={tailLines} />),
      tailLines,
    );
  } finally {
    instance.unmount();
    await instance.waitUntilExit();
  }
}
