import { existsSync, readFileSync } from "node:fs";
import { InputValidationError } from "../../errors";
import type { DevEvent, DevRunner, DevServerInput } from "../../handlers/project/dev/types";
import { streamProcess, type ProcessStreamer } from "../../io";
import { projectSpecPath } from "../project/fsUtils";
import {
  BOX_INGRESS_PORT,
  boxProfilePath,
  defaultBoxProfilesDirectory,
} from "../project/templates/boxProfile";

type BoxDevRunnerConfig = {
  /** The runner used when the project has no box profile. */
  fallback: DevRunner;
  streamProcess?: ProcessStreamer;
  /** The folder of box profiles; `~/.box/profiles` by default. */
  profilesDirectory?: string;
};

/**
 * Runs a CodeZip agent with `box run <project>` when the project has a box
 * profile, the one `agentcore create` writes, and with the fallback runner
 * otherwise. The box listens on the profile's ingress port and relays to the
 * agent, so the dev port must be that port.
 */
export class BoxDevRunner implements DevRunner {
  private readonly fallback: DevRunner;
  private readonly streamProcess: ProcessStreamer;
  private readonly profilesDirectory: string;

  constructor(config: BoxDevRunnerConfig) {
    this.fallback = config.fallback;
    this.streamProcess = config.streamProcess ?? streamProcess;
    this.profilesDirectory = config.profilesDirectory ?? defaultBoxProfilesDirectory();
  }

  public async *run(input: DevServerInput): AsyncGenerator<DevEvent, void> {
    const name = projectName(input.projectRoot);
    const profile = name === undefined ? undefined : boxProfilePath(this.profilesDirectory, name);
    if (name === undefined || profile === undefined || !existsSync(profile)) {
      yield* this.fallback.run(input);
      return;
    }
    if (input.port !== BOX_INGRESS_PORT) {
      throw new InputValidationError(
        `the box profile ${profile} listens on port ${BOX_INGRESS_PORT}, but dev chose port ` +
          `${input.port}. Free port ${BOX_INGRESS_PORT}, or change [[agent.ingress]] listen in the profile.`,
      );
    }
    yield { type: "status", message: `Starting the agent in a box (box run ${name})` };
    yield* this.streamProcess(["box", "run", name, "--no-banner"], {
      cwd: input.projectRoot,
      env: { ...process.env },
      signal: input.signal,
    });
  }
}

/** The project's name from its spec, which is also the name of its box profile. */
function projectName(projectRoot: string): string | undefined {
  try {
    const spec: unknown = JSON.parse(readFileSync(projectSpecPath(projectRoot), "utf8"));
    const name = (spec as { name?: unknown }).name;
    return typeof name === "string" ? name : undefined;
  } catch {
    return undefined;
  }
}
