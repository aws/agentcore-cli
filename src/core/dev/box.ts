import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { InputValidationError, ResourceNotFoundError } from "../../errors";
import type { DevEvent, DevRunner, DevServerInput } from "../../handlers/project/dev/types";
import { streamProcess, type ProcessStreamer } from "../../io";
import { requireTool } from "../../io/exec";
import { BOX_INSTALL_HINT } from "../project/backends/boxRelease";
import {
  BOX_PROFILE_FILE,
  boxIngressPort,
  boxProfileIsFor,
  boxProfilePath,
  runsBoxStartScript,
} from "../project/templates/boxProfile";

type BoxDevRunnerConfig = {
  /** The runner used when the project has no box profile. */
  fallback: DevRunner;
  streamProcess?: ProcessStreamer;
  /** Fails when `box` is not on PATH, with the install hint; tests inject one. */
  checkTool?: (tool: string, installHint: string) => Promise<void>;
};

/**
 * Runs a CodeZip agent with `box run .box/profile.toml` in the project folder
 * when the project has that box profile, the one `agentcore create` writes,
 * and with the fallback runner otherwise. `box` is the one on PATH, which the
 * user installs from the box release. The box listens on the profile's
 * ingress port and relays to the agent, so the dev port must be that port.
 */
export class BoxDevRunner implements DevRunner {
  private readonly fallback: DevRunner;
  private readonly streamProcess: ProcessStreamer;
  private readonly checkTool: NonNullable<BoxDevRunnerConfig["checkTool"]>;

  constructor(config: BoxDevRunnerConfig) {
    this.fallback = config.fallback;
    this.streamProcess = config.streamProcess ?? streamProcess;
    this.checkTool = config.checkTool ?? requireTool;
  }

  public async *run(input: DevServerInput): AsyncGenerator<DevEvent, void> {
    const profile = boxProfilePath(input.projectRoot);
    const hasProfile = existsSync(profile);
    if (!hasProfile || !boxProfileIsFor(readFileSync(profile, "utf8"), input.runtime)) {
      // start.py starts box on AgentCore Runtime, and runs no agent of its own.
      if (runsBoxStartScript(input.runtime.entrypoint)) {
        throw new ResourceNotFoundError(
          `runtime "${input.runtime.name}" runs its agent in a box (entrypoint ` +
            `${input.runtime.entrypoint}), but ${profile} ` +
            (hasProfile ? "is the box profile of another runtime." : "does not exist.") +
            " Restore the profile that `agentcore create` wrote.",
        );
      }
      if (hasProfile) {
        yield {
          type: "status",
          message: `Running without a box: ${profile} is the box profile of another runtime`,
        };
      }
      yield* this.fallback.run(input);
      return;
    }
    const listen = boxIngressPort(input.runtime.protocol);
    if (input.port !== listen) {
      throw new InputValidationError(
        `the box profile ${profile} listens on port ${listen}, but dev chose port ` +
          `${input.port}. Free port ${listen}, then retry.`,
      );
    }
    const venv = join(input.projectRoot, input.runtime.codeLocation, ".venv");
    if (!existsSync(venv)) {
      throw new ResourceNotFoundError(
        `${venv} does not exist. Run \`uv sync\` in ${input.runtime.codeLocation}, then retry.`,
      );
    }
    await this.checkTool("box", BOX_INSTALL_HINT);
    if (input.env?.OTEL_EXPORTER_OTLP_ENDPOINT) {
      yield { type: "status", message: "Traces are not collected when the agent runs in a box" };
    }
    yield {
      type: "status",
      message: `Starting the agent in a box (box run ${BOX_PROFILE_FILE})`,
    };
    yield* this.streamProcess(["box", "run", BOX_PROFILE_FILE, "--no-banner"], {
      cwd: input.projectRoot,
      env: { ...process.env, ...credentialEnvironment(input.env) },
      signal: input.signal,
    });
  }
}

/**
 * The dev environment without its OTEL variables: the `agentcore/.env.local`
 * values, such as a model provider's API key. `box run` reads a profile's
 * `env://` credential from its own environment, and the agent gets only a
 * stand-in value. The OTEL variables point at dev's collector, which the box
 * does not reach.
 */
function credentialEnvironment(env: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env ?? {}).filter(([name]) => !name.startsWith("OTEL_")),
  );
}
