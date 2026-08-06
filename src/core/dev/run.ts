import { spawn } from "node:child_process";
import { ProcessFailedError } from "../../errors";

// NOTE: shape-compatible with src/io/exec.ts from #1872; fold into that
// module once it lands so the CLI has one CommandRunner.

export type CommandRunner = (
  command: string[],
  options: { cwd: string; onOutput?: (chunk: string) => void },
) => Promise<void>;

/**
 * Runs a one-shot command to completion, optionally streaming its combined
 * output. Used for setup steps (uv sync, npm install) where we want stdio
 * capturing it; rejects with {@link ProcessFailedError} on a non-zero exit.
 */
export const runCommand: CommandRunner = (command, { cwd, onOutput }) =>
  new Promise((resolve, reject) => {
    const [executable, ...args] = command;
    const child = spawn(executable!, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });

    let output = "";
    const collect = (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      onOutput?.(text);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);

    child.once("error", (error) => {
      reject(new ProcessFailedError([executable!, ...args], cwd, null, String(error)));
    });
    child.once("close", (exitCode) => {
      if (exitCode === 0) resolve();
      else reject(new ProcessFailedError([executable!, ...args], cwd, exitCode, output));
    });
  });
