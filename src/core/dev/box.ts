import { existsSync } from "node:fs";
import { join } from "node:path";
import { InputValidationError, ProjectStateError, ResourceNotFoundError } from "../../errors";
import type { DevEvent, DevRunner, DevServerInput } from "../../handlers/project/dev/types";
import { streamProcess, type ProcessStreamer } from "../../io";
import { requireTool } from "../../io/exec";
import { BOX_INSTALL_HINT } from "../project/backends/boxRelease";
import { boxDevSecrets, missingBoxSecretWarning } from "./boxDevSecrets";
import {
  boxIngressPort,
  boxLocalProfileFile,
  boxLocalProfilePath,
  runsBoxStartScript,
} from "../project/templates/boxProfile";

type BoxDevRunnerConfig = {
  /** The runner used when the project has no box profile. */
  fallback: DevRunner;
  streamProcess?: ProcessStreamer;
  /** Fails when `box` is not on PATH, with the install hint; tests inject one. */
  checkTool?: (tool: string, installHint: string) => Promise<void>;
  /** The environment `box run` starts from, the shell's by default; tests inject one. */
  processEnv?: NodeJS.ProcessEnv;
};

/**
 * Runs a CodeZip agent with `box run .box/<agentName>/local/profile.toml` in the project folder
 * when the project has that box profile, the one `agentcore create` writes,
 * and with the fallback runner otherwise. `box` is the one on PATH, which the
 * user installs from the box release. The box listens on the profile's
 * ingress port and relays to the agent, so the dev port must be that port.
 */
export class BoxDevRunner implements DevRunner {
  private readonly fallback: DevRunner;
  private readonly streamProcess: ProcessStreamer;
  private readonly checkTool: NonNullable<BoxDevRunnerConfig["checkTool"]>;
  private readonly processEnv: NodeJS.ProcessEnv;

  constructor(config: BoxDevRunnerConfig) {
    this.fallback = config.fallback;
    this.streamProcess = config.streamProcess ?? streamProcess;
    this.checkTool = config.checkTool ?? requireTool;
    this.processEnv = config.processEnv ?? process.env;
  }

  public async *run(input: DevServerInput): AsyncGenerator<DevEvent, void> {
    // As build and deploy, dev treats a runtime as boxed only in a Box project.
    if (!input.boxProject) {
      if (runsBoxStartScript(input.runtime.entrypoint)) {
        throw new ProjectStateError(
          notBoxProjectMessage(input.runtime.name, input.runtime.entrypoint),
        );
      }
      yield* this.fallback.run(input);
      return;
    }
    const profileFile = boxLocalProfileFile(input.runtime.name);
    const profile = boxLocalProfilePath(input.projectRoot, input.runtime.name);
    if (!existsSync(profile)) {
      // start.py starts box on AgentCore Runtime, and runs no agent of its own.
      if (runsBoxStartScript(input.runtime.entrypoint)) {
        throw new ResourceNotFoundError(
          `runtime "${input.runtime.name}" runs its agent in a box (entrypoint ` +
            `${input.runtime.entrypoint}), but ${profile} does not exist. ` +
            "Restore the profile that `agentcore create` wrote.",
        );
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
    const fileEnv = credentialEnvironment(input.env);
    // box reads each env:// key of the profile from its own environment. The shell's value wins
    // over agentcore/.env.local's, and dev writes neither anywhere.
    const secrets = await boxDevSecrets(input.projectRoot, input.runtime.name, {
      ...fileEnv,
      ...this.processEnv,
    });
    for (const missing of secrets.missing) {
      yield { type: "status", message: missingBoxSecretWarning(input.runtime.name, missing) };
    }
    yield {
      type: "status",
      message: `Starting the agent in a box (box run ${profileFile})`,
    };
    yield* this.streamProcess(["box", "run", profileFile, "--no-banner"], {
      cwd: input.projectRoot,
      env: { ...this.processEnv, ...fileEnv, ...secrets.env },
      signal: input.signal,
    });
  }
}

/**
 * Why dev cannot run a runtime that starts box: agentcore.json lost its `"projectType": "box"`, so
 * build and deploy would give it no Box gateway, and dev does not run it in a box either.
 */
export function notBoxProjectMessage(runtimeName: string, startsBoxWith: string): string {
  return (
    `runtime "${runtimeName}" runs its agent in a box (${startsBoxWith}), but agentcore.json ` +
    `has no "projectType": "box". Add "projectType": "box" back to agentcore.json, then retry.`
  );
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
