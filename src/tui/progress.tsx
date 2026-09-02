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
  const tasks: Task[] = [];
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
  const draw = () => instance.rerender(<TaskList tasks={[...tasks]} tailLines={tailLines} />);
  const current = () => tasks[tasks.length - 1];

  try {
    let next = await generator.next();
    while (!next.done) {
      const event = next.value;
      if (event.type === "step") {
        const previous = current();
        if (previous) {
          previous.state = "done";
          previous.tail = [];
        }
        tasks.push({ title: event.message, state: "running", tail: [] });
      } else {
        // An output line before the first step has nowhere to render; the
        // debug log still has it.
        const task = current();
        if (task) task.tail = [...task.tail, event.line].slice(-tailLines);
      }
      draw();
      next = await generator.next();
    }
    const last = current();
    if (last) {
      last.state = "done";
      last.tail = [];
    }
    draw();
    return next.value;
  } catch (error) {
    // The failed step keeps its tail: the last frame stays in scrollback above
    // the error message runWithExitCode prints after the rethrow.
    const task = current();
    if (task) task.state = "failed";
    draw();
    throw error;
  } finally {
    instance.unmount();
    await instance.waitUntilExit();
  }
}
