/**
 * Box's own resolution of a box profile. `box profile show <profile> --full` prints the `box.toml`
 * and `policy.dw` that a run of the profile gets, with every pack, option, and rule Box adds
 * already in them, so build reads them rather than compiling the profile itself.
 */
import { InvalidEnvironmentError } from "../../errors/errors";
import { ProcessFailedError, streamProcess, type ProcessStreamer } from "../../io";

/** The `box.toml` and `policy.dw` that Box resolves a box profile to. */
export interface ResolvedBoxProfile {
  readonly boxToml: string;
  readonly policy: string;
}

/** Resolves the box profile at `profilePath`, relative to `projectRoot`, as a run there gets it. */
export interface BoxProfileResolver {
  resolve(projectRoot: string, profilePath: string): Promise<ResolvedBoxProfile>;
}

const BOX_TOML_HEADING = "# box.toml";
const POLICY_HEADING = "# policy.dw";

/** Where to get box, which the error names when `box` is not on PATH. */
const BOX_RELEASES_URL = "https://github.com/mquang-amazon/box-releases";

/**
 * The `box.toml` and `policy.dw` sections of the output of `box profile show --full`, or
 * `undefined` when it has no such sections. The policy cannot hold the `# policy.dw` line, as
 * Dogwood refuses it, so the last one starts the policy.
 */
export function parseBoxProfileShow(stdout: string): ResolvedBoxProfile | undefined {
  const lines = stdout.split(/\r?\n/);
  const toml = lines.indexOf(BOX_TOML_HEADING);
  const policy = lines.lastIndexOf(POLICY_HEADING);
  if (toml === -1 || policy <= toml) return undefined;
  return {
    boxToml: lines.slice(toml + 1, policy).join("\n"),
    policy: lines.slice(policy + 1).join("\n"),
  };
}

/** Runs `box profile show --full` with the `box` on PATH, which `agentcore dev` runs too. */
export class BoxCliProfileResolver implements BoxProfileResolver {
  private readonly env: NodeJS.ProcessEnv;
  private readonly streamProcess: ProcessStreamer;

  constructor(config: { env?: NodeJS.ProcessEnv; streamProcess?: ProcessStreamer } = {}) {
    this.env = config.env ?? process.env;
    this.streamProcess = config.streamProcess ?? streamProcess;
  }

  public async resolve(projectRoot: string, profilePath: string): Promise<ResolvedBoxProfile> {
    const command = ["box", "profile", "show", profilePath, "--full"];
    const shown = `\`${command.join(" ")}\``;
    const stdout: string[] = [];
    const stderr: string[] = [];
    try {
      const events = this.streamProcess(command, {
        cwd: projectRoot,
        env: { ...this.env, NO_COLOR: "1" },
      });
      for await (const event of events) {
        (event.type === "stdout" ? stdout : stderr).push(event.line);
      }
    } catch (error) {
      if (!(error instanceof ProcessFailedError)) throw error;
      if (error.meta.exitCode === null && stderr.length === 0) {
        throw new InvalidEnvironmentError(
          `build and deploy read ${profilePath} with ${shown}, as Box resolves it, and box did ` +
            `not start: ${lastLine(error.message)}. Put box on PATH, as \`agentcore dev\` needs ` +
            `it (${BOX_RELEASES_URL}), then retry.`,
          { cause: error },
        );
      }
      throw new InvalidEnvironmentError(
        `${shown} failed in ${projectRoot} (exit code ${String(error.meta.exitCode ?? "unknown")}), ` +
          `so build cannot read the box profile as Box resolves it:\n${boxError(stderr)}\n` +
          `Fix what box names, so that \`box profile show ${profilePath}\` succeeds in the project ` +
          "folder, then retry.",
        { cause: error },
      );
    }
    const resolved = parseBoxProfileShow(stdout.join("\n"));
    if (resolved === undefined) {
      throw new InvalidEnvironmentError(
        `${shown} printed no "${BOX_TOML_HEADING}" and "${POLICY_HEADING}" sections, which build ` +
          `reads. Install a box that prints them (${BOX_RELEASES_URL}), then retry.`,
      );
    }
    return resolved;
  }
}

/** Box's error lines, without the usage text that box prints after them. */
function boxError(stderr: readonly string[]): string {
  const usage = stderr.findIndex((line) => line.startsWith("Usage: box"));
  const lines = usage === -1 ? stderr : stderr.slice(0, usage);
  return lines.map((line) => `  ${line}`).join("\n");
}

function lastLine(text: string): string {
  return text.trim().split("\n").at(-1) ?? text;
}
