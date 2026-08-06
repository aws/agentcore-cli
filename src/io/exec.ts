// Local subprocess execution. Uses node:child_process (not Bun.$/Bun.spawn)
// because the npm bundle targets Node — Bun APIs are unavailable there.
import { spawn } from "node:child_process";
import { MissingToolError, ProcessFailedError } from "../errors";

// cmd.exe resolves PATHEXT executables (npm.cmd, uv.exe) that a bare spawn misses.
const useShell = process.platform === "win32";

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
