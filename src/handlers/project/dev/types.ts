import type { ProjectRuntime } from "../../../core/project/schema";

/** Severity of a line emitted by a dev server. `system` marks CLI-originated
 *  status messages (venv setup, restarts) as opposed to agent output. */
export type DevLogLevel = "info" | "warn" | "error" | "system";

/** How a dev server process ended. */
export type ProcessExit =
  | { kind: "exited"; code: number }
  | { kind: "signaled"; signal: string }
  | { kind: "spawn-error"; error: Error };

export type StartDevServerInput = {
  /** The runtime to run, as registered in agentcore.json. */
  runtime: ProjectRuntime;
  /** Absolute path to the project root (parent of agentcore/). */
  projectRoot: string;
  /** Port the server binds to. */
  port: number;
  /** Extra environment variables for the agent process. */
  env?: Record<string, string>;
  /** Receives every output line from the server and the CLI's own status messages. */
  onLog: (level: DevLogLevel, message: string) => void;
};

/** A running dev server process. */
export interface DevServerHandle {
  /** Resolves once the process ends and its output streams have flushed. */
  readonly exited: Promise<ProcessExit>;
  /** Stops the server (graceful signal, then hard kill) and resolves once it has fully ended. */
  stop(): Promise<ProcessExit>;
}

/**
 * Starts a local dev server for a runtime. Implementations cover the build
 * types (CodeZip today, Container next).
 */
export interface DevRunner {
  start(input: StartDevServerInput): Promise<DevServerHandle>;
}
