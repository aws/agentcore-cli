import { existsSync } from "node:fs";
import { InputValidationError, ResourceNotFoundError } from "../../errors";
import type { DevEvent, DevRunner, DevServerInput } from "../../handlers/project/dev/types";
import { streamProcess, type ProcessStreamer } from "../../io";
import { boxReleaseFor, resolveBoxDevBinary } from "../project/backends/boxRelease";
import {
  BOX_PROFILE_FILE,
  boxIngressPort,
  boxProfilePath,
  runsBoxStartScript,
} from "../project/templates/boxProfile";

type BoxDevRunnerConfig = {
  /** The runner used when the project has no box profile. */
  fallback: DevRunner;
  streamProcess?: ProcessStreamer;
  /**
   * The `box` to run: the release's build for this machine, downloaded once into
   * `~/.agentcore/box/`, else `undefined`, for the `box` on PATH. Tests inject one.
   */
  resolveBox?: (version: string | undefined) => Promise<string | undefined>;
};

/**
 * Runs a CodeZip agent with `box run .box/profile.toml` in the project folder
 * when the project has that box profile, the one `agentcore create` writes,
 * and with the fallback runner otherwise. `box` is the release's build for this
 * machine (see `resolveBoxDevBinary`), or the one on PATH when it has none. The box listens on the profile's
 * ingress port and relays to the agent, so the dev port must be that port.
 */
export class BoxDevRunner implements DevRunner {
  private readonly fallback: DevRunner;
  private readonly streamProcess: ProcessStreamer;
  private readonly resolveBox: (version: string | undefined) => Promise<string | undefined>;

  constructor(config: BoxDevRunnerConfig) {
    this.fallback = config.fallback;
    this.streamProcess = config.streamProcess ?? streamProcess;
    this.resolveBox =
      config.resolveBox ??
      (async (version) =>
        resolveBoxDevBinary(process.env, { release: await boxReleaseFor(version, process.env) }));
  }

  public async *run(input: DevServerInput): AsyncGenerator<DevEvent, void> {
    const profile = boxProfilePath(input.projectRoot);
    if (!existsSync(profile)) {
      // start.py starts box on AgentCore Runtime, and runs no agent of its own.
      if (runsBoxStartScript(input.runtime.entrypoint)) {
        throw new ResourceNotFoundError(
          `runtime "${input.runtime.name}" runs its agent in a box (entrypoint ` +
            `${input.runtime.entrypoint}), but its box profile ${profile} does not exist. ` +
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
          `${input.port}. Free port ${listen}, or change [[agent.ingress]] listen in the profile.`,
      );
    }
    // The runtime's box.version in agentcore.json, else the box release this CLI pins.
    const box = (await this.resolveBox(input.runtime.box?.version)) ?? "box";
    yield {
      type: "status",
      message: `Starting the agent in a box (${box} run ${BOX_PROFILE_FILE})`,
    };
    yield* this.streamProcess([box, "run", BOX_PROFILE_FILE, "--no-banner"], {
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
