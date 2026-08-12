// Local subprocess execution. Uses node:child_process (not Bun.$/Bun.spawn)
// because the npm bundle targets Node — Bun APIs are unavailable there.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { AgentCoreCLIError, ERROR_SOURCE } from "../errors";

// cmd.exe resolves PATHEXT executables (npm.cmd, uv.exe) that a bare spawn misses.
const useShell = process.platform === "win32";
const KILL_GRACE_MS = 2000;
const MAX_ERROR_OUTPUT_LINES = 20;

/** Error raised when a required executable is not found on PATH. */
export class MissingToolError extends AgentCoreCLIError {
  constructor(tool: string, installHint: string) {
    super(`'${tool}' was not found on your PATH. ${installHint}`, {
      source: ERROR_SOURCE.USER,
      meta: { tool },
    });
  }
}

/** Error raised when a subprocess exits non-zero, carrying its captured output. */
export class ProcessFailedError extends AgentCoreCLIError {
  constructor(command: string[], cwd: string, exitCode: number | null, output: string) {
    const rendered = command.join(" ");
    super(
      `'${rendered}' failed in ${cwd} (exit code ${exitCode ?? "unknown"}).\n\n` +
        `${output.trim()}\n\n` +
        `Fix the issue and run 'cd ${cwd} && ${rendered}' to retry.`,
      { source: ERROR_SOURCE.USER, meta: { command, cwd, exitCode } },
    );
  }
}

/** Returns true if running `tool` with probeArgs (`--version` by default) exits 0. */
export function toolAvailable(tool: string, probeArgs: string[] = ["--version"]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(tool, probeArgs, { stdio: "ignore", shell: useShell });
    child.on("error", () => resolve(false));
    child.on("close", (exitCode) => resolve(exitCode === 0));
  });
}

/** Throws {@link MissingToolError} unless `tool` is available. */
export async function requireTool(
  tool: string,
  installHint: string,
  probeArgs?: string[],
): Promise<void> {
  if (!(await toolAvailable(tool, probeArgs))) throw new MissingToolError(tool, installHint);
}

export type RunProcessOptions = {
  /** Working directory the process runs in. */
  cwd: string;
  /** Receives each chunk of combined stdout/stderr as it streams (e.g. into a logger). */
  onOutput?: (chunk: string) => void;
};

/** Runs a subprocess to completion. Injectable so tests never spawn real processes. */
export type ProcessRunner = (command: string[], options: RunProcessOptions) => Promise<void>;

export type ProcessEvent = { type: "stdout"; line: string } | { type: "stderr"; line: string };

export type StreamProcessOptions = {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** Command rendered in errors when the actual arguments contain sensitive values. */
  redactedCommand?: string[];
  /** Required on Windows for command scripts such as npm.cmd. */
  shell?: boolean;
};

export type ProcessStreamer = (
  command: string[],
  options: StreamProcessOptions,
) => AsyncGenerator<ProcessEvent, void>;

/**
 * Runs a subprocess, streaming combined stdout/stderr to `onOutput` while also
 * capturing it; rejects with {@link ProcessFailedError} on a non-zero exit.
 */
export const runProcess: ProcessRunner = ([executable, ...args], { cwd, onOutput }) => {
  return new Promise((resolve, reject) => {
    const child = spawn(executable!, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: useShell,
    });

    let output = "";
    const collect = (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      onOutput?.(text);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    child.on("error", (error) => {
      reject(new ProcessFailedError([executable!, ...args], cwd, null, String(error)));
    });
    child.on("close", (exitCode) => {
      if (exitCode === 0) resolve();
      else reject(new ProcessFailedError([executable!, ...args], cwd, exitCode, output));
    });
  });
};

/**
 * Runs a subprocess until it exits or is aborted, yielding complete output
 * lines while preserving their source stream.
 */
export async function* streamProcess(
  command: string[],
  options: StreamProcessOptions,
): AsyncGenerator<ProcessEvent, void> {
  const [executable, ...args] = command;
  const errorCommand = options.redactedCommand ?? command;
  if (!executable) {
    throw new ProcessFailedError(errorCommand, options.cwd, null, "command is empty");
  }
  if (options.signal?.aborted) throw abortReason(options.signal);

  let child: ChildProcess;
  try {
    child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: options.shell ?? false,
      detached: !useShell,
    });
  } catch (error) {
    throw new ProcessFailedError(errorCommand, options.cwd, null, String(error));
  }

  const events: ProcessEvent[] = [];
  const recentOutput: string[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  let spawnError: Error | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let terminating = false;
  let resolveClosed: () => void = () => {};
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const notify = () => {
    wake?.();
    wake = undefined;
  };
  const finish = () => {
    if (closed) return;
    closed = true;
    resolveClosed();
    notify();
  };
  const push = (event: ProcessEvent) => {
    if (!event.line) return;
    events.push(event);
    recentOutput.push(event.line);
    if (recentOutput.length > MAX_ERROR_OUTPUT_LINES) recentOutput.shift();
    notify();
  };
  const terminate = () => {
    if (closed || terminating) return;
    terminating = true;
    killTree(child, "SIGTERM");
    killTimer = setTimeout(() => killTree(child, "SIGKILL"), KILL_GRACE_MS);
    killTimer.unref();
    notify();
  };

  const stdout = createInterface({ input: child.stdout! });
  const stderr = createInterface({ input: child.stderr! });
  stdout.on("line", (line) => push({ type: "stdout", line }));
  stderr.on("line", (line) => push({ type: "stderr", line }));

  child.once("error", (error) => {
    spawnError = error;
    finish();
  });
  child.once("close", (code, signal) => {
    exitCode = code;
    exitSignal = signal;
    finish();
  });
  options.signal?.addEventListener("abort", terminate, { once: true });

  try {
    while (!closed || events.length > 0) {
      const event = events.shift();
      if (event) {
        yield event;
      } else {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    }

    if (options.signal?.aborted) throw abortReason(options.signal);
    if (spawnError) {
      throw new ProcessFailedError(errorCommand, options.cwd, null, String(spawnError));
    }
    if (exitCode !== 0) {
      const signalMessage = exitSignal ? `terminated by ${exitSignal}` : "";
      throw new ProcessFailedError(
        errorCommand,
        options.cwd,
        exitCode,
        [...recentOutput, signalMessage].filter(Boolean).join("\n"),
      );
    }
  } finally {
    options.signal?.removeEventListener("abort", terminate);
    stdout.close();
    stderr.close();
    if (!closed) {
      terminate();
      await closedPromise;
    }
    if (processTreeAlive(child)) killTree(child, "SIGKILL");
    if (killTimer) clearTimeout(killTimer);
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    if (useShell) {
      execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(-child.pid, signal);
    }
  } catch {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  }
}

function processTreeAlive(child: ChildProcess): boolean {
  if (useShell || !child.pid) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch {
    return false;
  }
}
