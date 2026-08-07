import { existsSync } from "node:fs";
import { join } from "node:path";
import { InputValidationError } from "../../errors";
import type { DevEvent, DevRunner, DevServerInput } from "../../handlers/project/dev/types";
import { streamProcess, type ProcessStreamer, type StreamProcessOptions } from "../../io";

type CodeZipDevRunnerConfig = {
  streamProcess?: ProcessStreamer;
};

export class CodeZipDevRunner implements DevRunner {
  private readonly streamProcess: ProcessStreamer;

  constructor(config: CodeZipDevRunnerConfig = {}) {
    this.streamProcess = config.streamProcess ?? streamProcess;
  }

  public async *run(input: DevServerInput): AsyncGenerator<DevEvent, void> {
    const directory = join(input.projectRoot, input.runtime.codeLocation);
    if (!existsSync(directory)) {
      throw new InputValidationError(`runtime code directory not found: ${directory}`);
    }

    const [entrypoint] = input.runtime.entrypoint.split(":");
    if (!entrypoint!.endsWith(".py") && !existsSync(join(directory, "node_modules"))) {
      yield { type: "status", message: "Installing Node dependencies with npm" };
      yield* this.streamProcess(["npm", "install"], { cwd: directory, signal: input.signal });
    }

    yield { type: "status", message: "Starting development server" };
    const process = commandForRuntime(entrypoint!, directory, input);
    yield* this.streamProcess(process.command, process.options);
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
      options: { cwd: directory, env, signal: input.signal },
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
