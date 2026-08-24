import { existsSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { InputValidationError } from "../../errors";
import type { DevEvent, DevRunner, DevServerInput } from "../../handlers/project/dev/types";
import {
  runProcess,
  streamProcess,
  type ProcessRunner,
  type ProcessStreamer,
  type StreamProcessOptions,
} from "../../io";
import { isDirectory, isFile, resolvePathWithinProject } from "./path";

type CodeZipDevRunnerConfig = {
  streamProcess?: ProcessStreamer;
  runProcess?: ProcessRunner;
};

const SITECUSTOMIZE_MARKER = "AGENTCORE_OTEL_SITECUSTOMIZE=";

export class CodeZipDevRunner implements DevRunner {
  private readonly streamProcess: ProcessStreamer;
  private readonly runProcess: ProcessRunner;

  constructor(config: CodeZipDevRunnerConfig = {}) {
    this.streamProcess = config.streamProcess ?? streamProcess;
    this.runProcess = config.runProcess ?? runProcess;
  }

  public async *run(input: DevServerInput): AsyncGenerator<DevEvent, void> {
    const directory = resolve(input.projectRoot, input.runtime.codeLocation);
    if (!isDirectory(directory)) {
      throw new InputValidationError(`runtime code directory not found: ${directory}`);
    }
    resolvePathWithinProject(input.projectRoot, directory, "runtime code directory");

    const [entrypoint] = input.runtime.entrypoint.split(":");
    const entrypointPath = resolve(directory, entrypoint!);
    if (!isFile(entrypointPath)) {
      throw new InputValidationError(`runtime entrypoint not found: ${entrypointPath}`);
    }
    resolvePathWithinProject(input.projectRoot, entrypointPath, "runtime entrypoint");

    if (!entrypoint!.endsWith(".py") && !existsSync(join(directory, "node_modules"))) {
      yield { type: "status", message: "Installing Node dependencies with npm" };
      yield* this.streamProcess(["npm", "install"], {
        cwd: directory,
        signal: input.signal,
        shell: process.platform === "win32",
      });
    }

    yield { type: "status", message: "Starting development server" };
    const serverProcess = commandForRuntime(entrypoint!, directory, input);
    if (entrypoint!.endsWith(".py") && input.env?.OTEL_EXPORTER_OTLP_ENDPOINT) {
      const sitecustomizeDir = await this.findOtelSitecustomizeDir(directory, input.signal);
      if (sitecustomizeDir) {
        const existing = serverProcess.options.env?.PYTHONPATH;
        serverProcess.options.env = {
          ...serverProcess.options.env,
          PYTHONPATH: existing ? `${sitecustomizeDir}${delimiter}${existing}` : sitecustomizeDir,
        };
      } else {
        yield {
          type: "status",
          message:
            "OTEL auto-instrumentation is not installed in the agent environment; traces will not be collected. Add aws-opentelemetry-distro to the agent's dependencies to enable them.",
        };
      }
    }
    yield* this.streamProcess(serverProcess.command, serverProcess.options);
  }

  /**
   * Locate the auto-instrumentation sitecustomize.py directory inside the agent's
   * uv environment. Prepending it to PYTHONPATH instruments every Python process —
   * an `opentelemetry-instrument` wrapper would only instrument uvicorn's reloader
   * parent, leaving the re-spawned worker processes untraced.
   */
  private async findOtelSitecustomizeDir(
    directory: string,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    const output: string[] = [];
    // uv writes sync progress to stderr, which merges into onOutput, so the path
    // is printed behind a marker and read from that line rather than the last one.
    const script = `import opentelemetry.instrumentation.auto_instrumentation as m, os; print("${SITECUSTOMIZE_MARKER}" + os.path.dirname(m.__file__))`;
    try {
      await this.runProcess(["uv", "run", "python", "-c", script], {
        cwd: directory,
        onOutput: (chunk) => output.push(chunk),
        signal,
      });
    } catch {
      return undefined;
    }
    const marked = output
      .join("")
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith(SITECUSTOMIZE_MARKER));
    const sitecustomizeDir = marked?.slice(SITECUSTOMIZE_MARKER.length);
    if (!sitecustomizeDir || !existsSync(join(sitecustomizeDir, "sitecustomize.py")))
      return undefined;
    return sitecustomizeDir;
  }
}

function commandForRuntime(
  entrypoint: string,
  directory: string,
  input: DevServerInput,
): { command: string[]; options: StreamProcessOptions } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...input.env,
    PORT: String(input.port),
    LOCAL_DEV: "1",
  };

  if (input.runtime.protocol === "MCP") {
    env.FASTMCP_PORT = String(input.port);
  }

  if (!entrypoint.endsWith(".py")) {
    return {
      command: ["npm", "exec", "--", "tsx", "watch", entrypoint],
      options: {
        cwd: directory,
        env,
        signal: input.signal,
        shell: process.platform === "win32",
      },
    };
  }

  if ((input.runtime.protocol ?? "HTTP") !== "HTTP") {
    return {
      command: ["uv", "run", "python", entrypoint],
      options: { cwd: directory, env, signal: input.signal },
    };
  }

  const [, handler = "app"] = input.runtime.entrypoint.split(":");
  const module = entrypoint.replace(/\.py$/, "").replaceAll("/", ".");
  return {
    command: [
      "uv",
      "run",
      "uvicorn",
      `${module}:${handler}`,
      "--reload",
      "--host",
      "127.0.0.1",
      "--port",
      String(input.port),
    ],
    options: { cwd: directory, env, signal: input.signal },
  };
}
