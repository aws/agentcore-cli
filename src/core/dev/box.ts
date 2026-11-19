import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { InputValidationError, ProjectStateError, ResourceNotFoundError } from "../../errors";
import type { DevEvent, DevRunner, DevServerInput } from "../../handlers/project/dev/types";
import { streamProcess, type ProcessStreamer } from "../../io";
import { requireTool } from "../../io/exec";
import { BOX_INSTALL_HINT } from "../project/backends/boxRelease";
import { boxDevSecrets, missingBoxSecretWarning } from "./boxDevSecrets";
import {
  BOX_PROFILE_FILE,
  boxIngressPort,
  boxProfileIsFor,
  boxProfilePath,
  runsInBox,
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
  private readonly processEnv: NodeJS.ProcessEnv;

  constructor(config: BoxDevRunnerConfig) {
    this.fallback = config.fallback;
    this.streamProcess = config.streamProcess ?? streamProcess;
    this.checkTool = config.checkTool ?? requireTool;
    this.processEnv = config.processEnv ?? process.env;
  }

  public async *run(input: DevServerInput): AsyncGenerator<DevEvent, void> {
    const profile = boxProfilePath(input.projectRoot);
    // As build and deploy, dev decides whether a runtime is boxed from runsInBox alone.
    if (!runsInBox(input.boxProject, input.runtime)) {
      if (input.runtime.box !== undefined) {
        throw new ProjectStateError(notBoxProjectMessage(input.runtime.name));
      }
      // A box profile here was written for a box runtime, so say why dev does not use it.
      if (existsSync(profile)) {
        yield {
          type: "status",
          message: input.boxProject
            ? `Running without a box: runtime "${input.runtime.name}" has no box.version in agentcore.json`
            : 'Running without a box: agentcore.json has no "projectType": "box"',
        };
      }
      yield* this.fallback.run(input);
      return;
    }
    const hasProfile = existsSync(profile);
    if (!hasProfile || !boxProfileIsFor(readFileSync(profile, "utf8"), input.runtime)) {
      throw new ResourceNotFoundError(
        `runtime "${input.runtime.name}" runs its agent in a box (it has box.version in ` +
          `agentcore.json), but ${profile} ` +
          (hasProfile ? "is the box profile of another runtime." : "does not exist.") +
          " Restore the profile that `agentcore create` wrote.",
      );
    }
    const listen = boxIngressPort(input.runtime.protocol);
    if (input.port !== listen) {
      throw new InputValidationError(
        `the box profile ${profile} listens on port ${listen}, but dev chose port ` +
          `${input.port}. Free port ${listen}, then retry.`,
      );
    }
    // `create --skip-install` leaves an empty .venv, which `uv sync` fills; the profile runs its
    // Python.
    const venv = join(input.projectRoot, input.runtime.codeLocation, ".venv");
    if (!existsSync(join(venv, "bin", "python"))) {
      throw new ResourceNotFoundError(
        `${venv} has no Python. Run \`uv sync\` in ${input.runtime.codeLocation}, then retry.`,
      );
    }
    await this.checkTool("box", BOX_INSTALL_HINT);
    if (input.env?.OTEL_EXPORTER_OTLP_ENDPOINT) {
      yield { type: "status", message: "Traces are not collected when the agent runs in a box" };
    }
    const fileEnv = credentialEnvironment(input.env);
    // box reads each env:// key of the profile from its own environment. The shell's value wins
    // over agentcore/.env.local's, and dev writes neither anywhere.
    const secrets = await boxDevSecrets(input.projectRoot, {
      ...fileEnv,
      ...this.processEnv,
    });
    for (const missing of secrets.missing) {
      yield { type: "status", message: missingBoxSecretWarning(missing) };
    }
    yield {
      type: "status",
      message: `Starting the agent in a box (box run ${BOX_PROFILE_FILE})`,
    };
    yield* this.streamProcess(["box", "run", BOX_PROFILE_FILE, "--no-banner"], {
      cwd: input.projectRoot,
      env: { ...this.processEnv, ...fileEnv, ...secrets.env },
      signal: input.signal,
    });
  }
}

/**
 * Why dev cannot run a box runtime: agentcore.json lost its `"projectType": "box"`, so build and
 * deploy would give it no Box gateway, and dev does not run it in a box either.
 */
export function notBoxProjectMessage(runtimeName: string): string {
  return (
    `runtime "${runtimeName}" runs its agent in a box (it has box.version), but agentcore.json ` +
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
