import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { InputValidationError, ProjectStateError, ResourceNotFoundError } from "../../errors";
import type { DevEvent, DevRunner, DevServerInput } from "../../handlers/project/dev/types";
import { runProcess, streamProcess, type ProcessRunner, type ProcessStreamer } from "../../io";
import { requireTool } from "../../io/exec";
import { BOX_INSTALL_HINT } from "../project/backends/boxRelease";
import { boxPolicyFileCopies } from "../project/boxNetworkSource";
import { boxDevSecrets, missingBoxSecretWarning, shadowedBoxSecretNote } from "./boxDevSecrets";
import {
  boxDevProfileFolder,
  boxDevTelemetryProfile,
  type BoxDevTelemetryOptions,
} from "./boxDevTelemetry";
import { findOtelSitecustomizeDir } from "./codezip";
import {
  boxIngressPort,
  boxLocalProfileFile,
  boxLocalProfilePath,
  boxStartFolder,
  observabilityOff,
  runsInBox,
} from "../project/templates/boxProfile";

type BoxDevRunnerConfig = {
  /** The runner used when the project has no box profile. */
  fallback: DevRunner;
  streamProcess?: ProcessStreamer;
  /** Runs the venv's Python to find its OTEL auto-instrumentation; tests inject one. */
  runProcess?: ProcessRunner;
  /** Fails when `box` is not on PATH, with the install hint; tests inject one. */
  checkTool?: (tool: string, installHint: string) => Promise<void>;
  /** The environment `box run` starts from, the shell's by default; tests inject one. */
  processEnv?: NodeJS.ProcessEnv;
  /** The platform, whose rules for variable names apply to `processEnv`; tests inject one. */
  platform?: NodeJS.Platform;
};

/**
 * Runs a CodeZip agent with `box run` in the runtime's folder when the project has the agent's
 * box profile, `.box/<agentName>/local/profile.toml`, and with the fallback runner otherwise.
 * `box` is the one on PATH, which the user installs from the box release. The box listens on the
 * profile's ingress port and relays to the agent, so the dev port must be that port.
 */
export class BoxDevRunner implements DevRunner {
  private readonly fallback: DevRunner;
  private readonly streamProcess: ProcessStreamer;
  private readonly runProcess: ProcessRunner;
  private readonly checkTool: NonNullable<BoxDevRunnerConfig["checkTool"]>;
  private readonly processEnv: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;

  constructor(config: BoxDevRunnerConfig) {
    this.fallback = config.fallback;
    this.streamProcess = config.streamProcess ?? streamProcess;
    this.runProcess = config.runProcess ?? runProcess;
    this.checkTool = config.checkTool ?? requireTool;
    this.processEnv = config.processEnv ?? process.env;
    this.platform = config.platform ?? process.platform;
  }

  public async *run(input: DevServerInput): AsyncGenerator<DevEvent, void> {
    const profileFile = boxLocalProfileFile(input.runtime.name);
    const profile = boxLocalProfilePath(input.projectRoot, input.runtime.name);
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
    if (!existsSync(profile)) {
      throw new ResourceNotFoundError(
        `runtime "${input.runtime.name}" runs its agent in a box (it has box.version in ` +
          `agentcore.json), but ${profile} does not exist. ` +
          "Restore the profile that `agentcore create` or `agentcore add runtime` wrote.",
      );
    }
    const profileText = readFileSync(profile, "utf8");
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
    // With dev's collector on, box runs a dev-time copy of the profile that sends the agent's spans
    // and logs, and box's own records, to the collector (boxDevTelemetry.ts).
    let runProfileFile = profileFile;
    const collector = input.env?.OTEL_EXPORTER_OTLP_ENDPOINT;
    if (collector && !observabilityOff(input.runtime)) {
      const sitecustomizeDir = await findOtelSitecustomizeDir(
        this.runProcess,
        join(input.projectRoot, input.runtime.codeLocation),
        input.signal,
      );
      if (sitecustomizeDir === undefined) {
        yield { type: "status", message: NO_AUTO_INSTRUMENTATION };
      } else {
        runProfileFile = await writeBoxDevProfile(
          input.projectRoot,
          input.runtime.name,
          profileText,
          {
            destination: collector,
            serviceName: input.runtime.name,
            sitecustomizeDir,
          },
        );
        yield {
          type: "status",
          message: `Traces of the agent and box's records go to the dev collector (box profile ${runProfileFile})`,
        };
      }
    }
    const fileEnv = credentialEnvironment(input.env);
    // box reads each env:// key of the profile from its own environment, picked as build picks it:
    // the shell's value when set and not blank, else agentcore/.env.local's. Dev writes neither.
    const secrets = boxDevSecrets(
      profileText,
      { env: this.processEnv, envLocal: fileEnv },
      this.platform,
    );
    for (const missing of secrets.missing) {
      yield { type: "status", message: missingBoxSecretWarning(profileFile, missing) };
    }
    for (const shadowed of secrets.shadowed) {
      yield { type: "status", message: shadowedBoxSecretNote(shadowed) };
    }
    // box starts in the runtime's code folder for a CodeZip runtime (the project root for a
    // container), so the agent reaches no other folder of the project; box finds the profile from
    // there.
    const startFolder = boxStartFolder(input.runtime);
    const cwd =
      startFolder === ""
        ? input.projectRoot
        : join(input.projectRoot, ...startFolder.split("/").filter(Boolean));
    const profileArg = posix.relative(startFolder, runProfileFile);
    yield {
      type: "status",
      message: `Starting the agent in a box (box run ${profileArg})`,
    };
    yield* this.streamProcess(["box", "run", profileArg, "--no-banner"], {
      cwd,
      env: { ...this.processEnv, ...fileEnv, ...secrets.env },
      signal: input.signal,
    });
  }
}

/** Why dev collects no traces of an agent whose venv lacks the OTEL auto-instrumentation. */
export const NO_AUTO_INSTRUMENTATION =
  "OTEL auto-instrumentation is not installed in the agent environment; traces will not be collected. Add aws-opentelemetry-distro to the agent's dependencies to enable them.";

/**
 * Writes the dev-time box profile of agent `agentName` (boxDevTelemetryProfile) and a copy of each
 * policy file the local profile names, into the git-ignored `agentcore/.cli/box-dev/<agentName>/`,
 * and returns the profile's path from the project root.
 */
async function writeBoxDevProfile(
  projectRoot: string,
  agentName: string,
  profileText: string,
  options: BoxDevTelemetryOptions,
): Promise<string> {
  const folder = boxDevProfileFolder(agentName);
  const directory = join(projectRoot, ...folder.split("/"));
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  const header =
    `# Written by agentcore dev from ${boxLocalProfileFile(agentName)} for this run, which it\n` +
    "# rewrites each time. Change the local profile instead.\n";
  await writeFile(
    join(directory, "profile.toml"),
    header + boxDevTelemetryProfile(profileText, options).text,
  );
  for (const { from, relative } of boxPolicyFileCopies(projectRoot, agentName)) {
    const to = join(directory, ...relative.split("/"));
    await mkdir(dirname(to), { recursive: true });
    await copyFile(from, to);
  }
  return posix.join(folder, "profile.toml");
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
