import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { AgentCoreCLIError, ERROR_SOURCE } from "../errors";

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
export class CommandFailedError extends AgentCoreCLIError {
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

/** Returns true if `tool` resolves to an executable on PATH. */
export function toolOnPath(tool: string): boolean {
  // On Windows executables carry a PATHEXT suffix (npm -> npm.cmd); elsewhere
  // the bare name is the file.
  const extensions =
    process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];
  return (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .some((dir) => extensions.some((ext) => existsSync(join(dir, tool + ext))));
}

/** Throws {@link MissingToolError} unless `tool` is available on PATH. */
export function requireTool(tool: string, installHint: string): void {
  if (!toolOnPath(tool)) throw new MissingToolError(tool, installHint);
}

export type RunCommandOptions = {
  /** Working directory the command runs in. */
  cwd: string;
  /** Receives each chunk of combined stdout/stderr as it streams (e.g. into a logger). */
  onOutput?: (chunk: string) => void;
};

/** Runs a command to completion. Injectable so tests never spawn real processes. */
export type CommandRunner = (command: string[], options: RunCommandOptions) => Promise<void>;

/**
 * Runs a command, streaming combined stdout/stderr to `onOutput` while also
 * capturing it; rejects with {@link CommandFailedError} on a non-zero exit.
 */
export const runCommand: CommandRunner = ([executable, ...args], { cwd, onOutput }) => {
  return new Promise((resolve, reject) => {
    // shell on win32 so PATHEXT resolution (npm.cmd etc.) works.
    const child = spawn(executable!, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
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
      reject(new CommandFailedError([executable!, ...args], cwd, null, String(error)));
    });
    child.on("close", (exitCode) => {
      if (exitCode === 0) resolve();
      else reject(new CommandFailedError([executable!, ...args], cwd, exitCode, output));
    });
  });
};
