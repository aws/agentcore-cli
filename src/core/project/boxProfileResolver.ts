/**
 * Box's own resolution of a box profile. `box profile show <profile> --format json --full` prints
 * the `box.toml` and `policy.dw` that a run of the profile gets, with every pack, option, and rule
 * Box adds already in them, so build reads them rather than compiling the profile itself.
 */
import { realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { z } from "zod";
import { InvalidEnvironmentError } from "../../errors/errors";
import { ProcessFailedError, streamProcess, type ProcessStreamer } from "../../io";

/** A pack of the profile, at the version Box resolves it to. */
export interface BoxPack {
  readonly name: string;
  readonly version: string;
}

/** A route with no secret, which Box leaves out of `box.toml` and writes only as rules. */
export interface BoxOpenRoute {
  readonly route: string;
  readonly destinations: readonly string[];
}

/** The `box.toml` and `policy.dw` that Box resolves a box profile to. */
export interface ResolvedBoxProfile {
  /** The `box.toml` as a table, with its keys in the order of the file. */
  readonly boxToml: Readonly<Record<string, unknown>>;
  readonly policy: string;
  readonly openRoutes: readonly BoxOpenRoute[];
  readonly packs: readonly BoxPack[];
  readonly warnings: readonly string[];
}

/** Resolves the box profile at `profilePath`, relative to `projectRoot`, as a run there gets it. */
export interface BoxProfileResolver {
  resolve(projectRoot: string, profilePath: string): Promise<ResolvedBoxProfile>;
}

/** Where to get box, which the error names when `box` is not on PATH. */
const BOX_RELEASES_URL = "https://github.com/mquang-amazon/box-releases";

/** The error of a box that has no `--format` or `--full` option, as clap prints it. */
const REFUSED_JSON = /(?:unexpected argument|Found argument) '--(?:format|full)'/;

/**
 * The destinations of an open route, as a list: box 0.1.11-linux-preview.6 joins them into one
 * string with ", ", and later boxes print a list.
 */
const OpenRouteDestinations = z
  .union([z.string(), z.array(z.string())])
  .transform((destinations) =>
    typeof destinations === "string" ? destinations.split(", ") : destinations,
  );

/** The parts of the document of `box profile show --format json --full` that build reads. */
const BoxProfileShowSchema = z.object({
  box_toml: z.record(z.string(), z.unknown()),
  policy: z.string(),
  open_routes: z.array(z.object({ route: z.string(), destinations: OpenRouteDestinations })),
  packs: z.array(z.object({ name: z.string(), version: z.string() })).default([]),
  warnings: z.array(z.string()).default([]),
});

/** Each key of the document, as the error names it when Box prints it wrong or not at all. */
const SHOWN_PARTS: Readonly<Record<keyof z.infer<typeof BoxProfileShowSchema>, string>> = {
  box_toml: "a box.toml table",
  policy: "the policy.dw text",
  open_routes: "a list of open routes",
  packs: "a list of packs",
  warnings: "a list of warnings",
};

/** `a, b, or c`. */
const LIST = new Intl.ListFormat("en", { type: "disjunction" });

/**
 * The profile `profilePath` as Box resolves it, from the document that
 * `box profile show --format json --full` prints on `stdout`. Throws when `stdout` is not one JSON
 * document, or lacks a part build reads.
 */
export function parseBoxProfileShow(stdout: string, profilePath: string): ResolvedBoxProfile {
  let document: unknown;
  try {
    document = JSON.parse(stdout);
  } catch (error) {
    throw new InvalidEnvironmentError(
      `Build cannot read what Box printed for the profile ${profilePath}, as it is not one JSON ` +
        `document. Run 'box profile show ${profilePath} --format json --full' in the project folder ` +
        "to see it.",
      { cause: error },
    );
  }
  const shown = BoxProfileShowSchema.safeParse(document);
  if (!shown.success) {
    const keys = new Set(shown.error.issues.map(({ path }) => path[0]));
    const wrong = Object.entries(SHOWN_PARTS).filter(([key]) => keys.has(key));
    // A document that is not an object holds none of the parts.
    const parts =
      wrong.length > 0 ? wrong.map(([, part]) => part) : [SHOWN_PARTS.box_toml, SHOWN_PARTS.policy];
    throw new InvalidEnvironmentError(
      `Box printed the profile ${profilePath} without ${LIST.format(parts)}, which build reads. ` +
        `Install a newer Box (${BOX_RELEASES_URL}), then retry.`,
      { cause: shown.error },
    );
  }
  const { box_toml: boxToml, policy, open_routes: openRoutes, packs, warnings } = shown.data;
  return { boxToml, policy, openRoutes, packs, warnings };
}

/** Runs `box profile show --format json --full` with the `box` on PATH. */
export class BoxCliProfileResolver implements BoxProfileResolver {
  private readonly env: NodeJS.ProcessEnv;
  private readonly streamProcess: ProcessStreamer;

  constructor(config: { env?: NodeJS.ProcessEnv; streamProcess?: ProcessStreamer } = {}) {
    this.env = config.env ?? process.env;
    this.streamProcess = config.streamProcess ?? streamProcess;
  }

  public async resolve(projectRoot: string, profilePath: string): Promise<ResolvedBoxProfile> {
    const command = ["box", "profile", "show", profilePath, "--format", "json", "--full"];
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
          `Box is not installed or not on PATH. Install it (${BOX_RELEASES_URL}), then retry.`,
          { cause: error },
        );
      }
      if (stderr.some((line) => REFUSED_JSON.test(line))) {
        throw new InvalidEnvironmentError(
          `This Box cannot print the profile ${profilePath} as JSON, which build reads. Install ` +
            `a Box release with \`box profile show --format json --full\` (${BOX_RELEASES_URL}), ` +
            "then retry.",
          { cause: error },
        );
      }
      const lines = boxError(stderr);
      if (lines.length === 0) {
        throw new InvalidEnvironmentError(
          `Box stopped on ${profilePath} with exit code ` +
            `${String(error.meta.exitCode ?? "unknown")} and printed no error. Run ` +
            `'box profile show ${profilePath}' in the project folder to see why.`,
          { cause: error },
        );
      }
      const agent = venvAgentFolder(lines, projectRoot);
      throw new InvalidEnvironmentError(
        [
          `Box refused the profile ${profilePath}:`,
          ...lines.map((line) => `  ${line}`),
          agent === undefined
            ? "Fix what Box reports, then retry."
            : `Run 'uv sync' in ${agent}, then retry.`,
        ].join("\n"),
        { cause: error },
      );
    }
    return parseBoxProfileShow(stdout.join("\n"), profilePath);
  }
}

/** Box's error lines, without the usage text that box prints after them, or blank lines. */
function boxError(stderr: readonly string[]): string[] {
  const usage = stderr.findIndex((line) => line.startsWith("Usage: box"));
  const lines = usage === -1 ? stderr : stderr.slice(0, usage);
  return lines.filter((line) => line.trim() !== "");
}

/**
 * The agent's folder, from the project root, when Box refuses the profile because the agent's
 * `.venv` lies under a write grant, as it does before `uv sync` makes the venv; else `undefined`.
 */
function venvAgentFolder(lines: readonly string[], projectRoot: string): string | undefined {
  for (const line of lines) {
    if (!line.includes("write grant")) continue;
    const folder = /(\S+?)[\\/]\.venv[\\/]/.exec(line)?.[1];
    if (folder === undefined) continue;
    const inside = relative(realPath(projectRoot), realPath(folder));
    if (inside === "") return "the project folder";
    const outside = inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside);
    return outside ? folder : inside.split(sep).join("/");
  }
  return undefined;
}

/** The path with every link resolved, or the path itself when it does not exist. */
function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
