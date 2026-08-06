import { existsSync } from "node:fs";
import { join } from "node:path";
import { ValidationError } from "../../errors";
import type {
  DevRunner,
  DevServerHandle,
  StartDevServerInput,
} from "../../handlers/project/dev/types";
import type { Logger } from "../../logging";
import { runCommand, type CommandRunner } from "./run";
import { ProcessSupervisor, windowsExecutable, type ProcessCommand } from "./process";

/** An entrypoint interpreted exactly once: "main.py:application" is the file
 *  "main.py", handler "application", language python. */
export type Entrypoint = {
  file: string;
  handler: string;
  language: "python" | "typescript";
};

/** Parses a runtime's entrypoint string into its parts. */
export function parseEntrypoint(entrypoint: string): Entrypoint {
  const [file, handler = "app"] = entrypoint.split(":");
  return {
    file: file!,
    handler,
    language: file!.endsWith(".py") ? "python" : "typescript",
  };
}

/** Detects the package manager for a Node project from its lockfile. */
export function nodePackageManager(directory: string): "npm" | "pnpm" | "yarn" {
  if (existsSync(join(directory, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(directory, "yarn.lock"))) return "yarn";
  return "npm";
}

type CodeZipDevRunnerConfig = {
  logger: Logger;
  /** Injectable process seams so tests never spawn uv or a real server. */
  run?: CommandRunner;
  supervisor?: ProcessSupervisor;
};

/**
 * Runs a CodeZip runtime locally. Python entrypoints get a uv-managed venv
 * and uvicorn with hot reload; TypeScript entrypoints run under tsx watch.
 */
export class CodeZipDevRunner implements DevRunner {
  private readonly logger: Logger;
  private readonly run: CommandRunner;
  private readonly supervisor: ProcessSupervisor;

  constructor(config: CodeZipDevRunnerConfig) {
    this.logger = config.logger;
    this.run = config.run ?? runCommand;
    this.supervisor = config.supervisor ?? new ProcessSupervisor();
  }

  public async start(input: StartDevServerInput): Promise<DevServerHandle> {
    const directory = join(input.projectRoot, input.runtime.codeLocation);
    if (!existsSync(directory)) {
      throw new ValidationError(`runtime code directory not found: ${directory}`);
    }

    const entrypoint = parseEntrypoint(input.runtime.entrypoint);
    if (entrypoint.language === "python") {
      await this.ensureVenv(directory, input);
    } else {
      await this.ensureNodeModules(directory, input);
    }

    return this.supervisor.spawn(serverCommand(entrypoint, directory, input), input.onLog);
  }

  /** Creates the venv and installs dependencies on first run; cheap no-op after. */
  private async ensureVenv(directory: string, input: StartDevServerInput): Promise<void> {
    if (existsSync(venvBin(directory, "uvicorn"))) return;

    input.onLog("system", "Setting up Python environment...");
    // uv sync creates the venv itself when missing.
    await this.run([windowsExecutable("uv", ".exe"), "sync"], {
      cwd: directory,
      onOutput: (chunk) => this.logger.debug(chunk.trim()),
    });
    input.onLog("system", "Python environment ready");
  }

  private async ensureNodeModules(directory: string, input: StartDevServerInput): Promise<void> {
    if (existsSync(join(directory, "node_modules"))) return;

    const packageManager = nodePackageManager(directory);
    input.onLog("system", `Installing Node dependencies with ${packageManager}...`);
    await this.run([windowsExecutable(packageManager), "install"], {
      cwd: directory,
      onOutput: (chunk) => this.logger.debug(chunk.trim()),
    });
    input.onLog("system", "Node dependencies ready");
  }
}

/** Builds the server command for an entrypoint. Pure: no process knowledge. */
export function serverCommand(
  entrypoint: Entrypoint,
  directory: string,
  input: StartDevServerInput,
): ProcessCommand {
  const env = {
    ...process.env,
    ...input.env,
    PORT: String(input.port),
    LOCAL_DEV: "1",
  };

  if (entrypoint.language === "python") {
    return {
      executable: venvBin(directory, "uvicorn"),
      args: [asgiApp(entrypoint), "--reload", "--host", "127.0.0.1", "--port", String(input.port)],
      cwd: directory,
      env,
    };
  }

  return {
    executable: windowsExecutable("npx"),
    args: ["tsx", "watch", entrypoint.file],
    cwd: directory,
    env,
  };
}

/** Path to an executable inside a directory's venv, per platform layout. */
function venvBin(directory: string, executable: string): string {
  return process.platform === "win32"
    ? join(directory, ".venv", "Scripts", `${executable}.exe`)
    : join(directory, ".venv", "bin", executable);
}

/** Renders an entrypoint in uvicorn's "module:attribute" form. */
function asgiApp(entrypoint: Entrypoint): string {
  return `${entrypoint.file.replace(/\.py$/, "").replaceAll("/", ".")}:${entrypoint.handler}`;
}
