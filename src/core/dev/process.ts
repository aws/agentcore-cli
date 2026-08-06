import { type ChildProcess, execSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { DevLogLevel, DevServerHandle, ProcessExit } from "../../handlers/project/dev/types";

const isWindows = process.platform === "win32";

/** How long a gracefully-signaled server gets to exit before the hard kill. */
const KILL_GRACE_MS = 2000;

/** CLI-terminating signals that would bypass the 'exit' event: Node kills the
 *  process without firing 'exit' when these arrive with no listener, which
 *  would orphan children on their ports. */
const REAP_SIGNALS: NodeJS.Signals[] = ["SIGTERM", "SIGHUP"];

/** A fully-resolved command: no shell involved, so argument boundaries are
 *  preserved exactly. Windows executables must already carry their extension
 *  (npm.cmd, uvicorn.exe) — see {@link windowsExecutable}. */
export type ProcessCommand = {
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
};

/** Appends the Windows extension to a bare tool name so it can be spawned
 *  without a shell. No-op elsewhere and for paths that already carry one. */
export function windowsExecutable(tool: string, extension = ".cmd"): string {
  return isWindows && !/\.[a-z0-9]+$/i.test(tool) ? `${tool}${extension}` : tool;
}

/**
 * Owns every dev server child of this CLI process: spawning, line-streamed
 * output, graceful shutdown, and a single process-exit reaper so children
 * cannot outlive the CLI and squat on their ports.
 */
export class ProcessSupervisor {
  private readonly children = new Set<ChildProcess>();
  private readonly reap = () => {
    for (const child of this.children) killTree(child, "SIGKILL");
  };
  private readonly reapAndExit = (signal: NodeJS.Signals) => {
    this.reap();
    // Exit as if unhandled: POSIX convention is 128 + signal number.
    process.exit(128 + (signal === "SIGTERM" ? 15 : 1));
  };

  /** Spawns a long-running server and returns its lifecycle handle. */
  public spawn(
    command: ProcessCommand,
    onLog: (level: DevLogLevel, message: string) => void,
  ): DevServerHandle {
    const child = spawn(command.executable, command.args, {
      cwd: command.cwd,
      env: command.env,
      stdio: ["ignore", "pipe", "pipe"],
      // Own process group on POSIX so a graceful signal reaches uvicorn's
      // reloader and its workers together.
      detached: !isWindows,
    });
    this.watch(child);

    streamLines(child.stdout, (line) => onLog("info", line));
    streamLines(child.stderr, (line) => onLog(levelOf(line), line));

    const exited = new Promise<ProcessExit>((resolve) => {
      child.once("error", (error) => {
        this.unwatch(child);
        onLog("error", `failed to start: ${command.executable}`);
        resolve({ kind: "spawn-error", error });
      });
      // 'close', not 'exit': close fires after the stdio streams have flushed,
      // so no output line can arrive after exited resolves.
      child.once("close", (code, signal) => {
        this.unwatch(child);
        resolve(signal ? { kind: "signaled", signal } : { kind: "exited", code: code ?? 0 });
      });
    });

    return {
      exited,
      stop() {
        if (child.exitCode === null && !child.killed) {
          killTree(child, "SIGTERM");
          const escalate = setTimeout(() => killTree(child, "SIGKILL"), KILL_GRACE_MS);
          escalate.unref();
          void exited.finally(() => clearTimeout(escalate));
        }
        return exited;
      },
    };
  }

  private watch(child: ChildProcess): void {
    // Attach the reapers once, on the first live child: the 'exit' handler
    // catches normal exits and uncaught exceptions, while the signal handlers
    // catch the terminations that never fire 'exit' (see REAP_SIGNALS). Both
    // exist so no dev server outlives the CLI and squats on its port.
    if (this.children.size === 0) {
      process.once("exit", this.reap);
      for (const signal of REAP_SIGNALS) process.once(signal, this.reapAndExit);
    }
    this.children.add(child);
  }

  private unwatch(child: ChildProcess): void {
    this.children.delete(child);
    if (this.children.size === 0) {
      process.removeListener("exit", this.reap);
      for (const signal of REAP_SIGNALS) process.removeListener(signal, this.reapAndExit);
    }
  }
}

/** Terminates the child's whole process tree. */
function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.exitCode !== null || !child.pid) return;
  try {
    if (isWindows) {
      // Windows has no process groups; taskkill /T walks the child tree.
      execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: "ignore" });
    } else {
      process.kill(-child.pid, signal);
    }
  } catch {
    child.kill(signal);
  }
}

/** Forwards a stdio stream to `onLine`, one complete line at a time.
 *  readline handles CRLF and multi-byte characters split across chunks. */
function streamLines(stream: NodeJS.ReadableStream | null, onLine: (line: string) => void): void {
  if (!stream) return;
  createInterface({ input: stream }).on("line", (line) => {
    if (line.trim()) onLine(line);
  });
}

/** Classifies a stderr line: servers log routinely to stderr, so only lines
 *  that look like problems are surfaced as such. */
function levelOf(line: string): DevLogLevel {
  const lower = line.toLowerCase();
  if (lower.includes("error")) return "error";
  if (lower.includes("warning")) return "warn";
  return "info";
}
