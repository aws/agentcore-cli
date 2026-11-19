/**
 * Reads the network inputs of a box profile from Box's own resolution of it: the `[egress]` and
 * `[mcp]` tables of the `box.toml` that `box profile show --format json --full` prints, and its
 * open routes. The profile's own `policies` name its policy files, and its own text places each
 * entry, `packs`, and `policies` for a message.
 */
import { posix } from "node:path";
import { parse as parseToml } from "smol-toml";
import type { ResolvedBoxProfile } from "../boxProfileResolver";
import { cloudWatchTelemetry, type ProfileCloudWatchTelemetry } from "./telemetry";

/** Where the profile's own text sets a key, as `<profile path>:line:column`. */
export interface ProfilePlaces {
  /** By `egress.<name>` and `mcp.<name>`, the first line that sets the entry. */
  readonly entries: ReadonlyMap<string, string>;
  readonly packs?: string;
  readonly policies?: string;
}

export interface ParsedProfile {
  /** The profile's path from the project root, which a failure names when it has no line. */
  readonly path: string;
  /** `[egress]` as Box resolves it, with each open route. */
  readonly egress: Record<string, unknown>;
  readonly mcp: Record<string, unknown>;
  /** The profile's own policy files, relative to its folder, in the order it names them. */
  readonly policyFiles: readonly string[];
  /** The CloudWatch targets of `[telemetry]` as Box resolves it; absent means none. */
  readonly telemetry?: readonly ProfileCloudWatchTelemetry[];
  /** Where the profile's own text sets each entry; absent when build has no profile text. */
  readonly places?: ProfilePlaces;
}

/** A failure of the profile, or of Box's resolution of it, at its line when one is known. */
export interface ProfileFailure {
  readonly code: "INVALID_PROFILE" | "UNSUPPORTED_POLICY_KEY";
  readonly reason: string;
  readonly place: string;
}

/**
 * The `[egress]` and `[mcp]` tables of the `box.toml` that Box resolves the profile at
 * `profilePath` to, with each open route after the routes of `[egress]`.
 */
export function parseResolvedProfile(
  { boxToml, openRoutes }: Pick<ResolvedBoxProfile, "boxToml" | "openRoutes">,
  policyFiles: readonly string[],
  profilePath: string,
): { readonly profile: ParsedProfile; readonly failures: readonly ProfileFailure[] } {
  for (const key of ["egress", "mcp"] as const) {
    if (boxToml[key] !== undefined && !isTable(boxToml[key])) {
      const reason =
        `Box resolves \`${key}\` in this profile to a value that is not a table. Write each ` +
        `entry as a table, such as [${key}.github].`;
      return {
        profile: { path: profilePath, egress: {}, mcp: {}, policyFiles },
        failures: [{ code: "INVALID_PROFILE", reason, place: profilePath }],
      };
    }
  }
  const egress: Record<string, unknown> = { ...(boxToml.egress as object | undefined) };
  const telemetry = cloudWatchTelemetry(boxToml);
  for (const { route, destinations } of openRoutes) {
    if (!Object.hasOwn(egress, route)) egress[route] = { destinations };
  }
  return {
    profile: {
      path: profilePath,
      egress,
      mcp: (boxToml.mcp as Record<string, unknown> | undefined) ?? {},
      policyFiles,
      ...(telemetry.length > 0 && { telemetry }),
    },
    failures: [],
  };
}

/**
 * The policy files that the box profile `text`, at `profilePath` from the project root, names
 * under `policies`, as Box reads them: files inside the profile's folder, each named once. It
 * refuses the `policy` key, as box does.
 */
export function profilePolicyFiles(
  text: string,
  profilePath: string,
): { ok: true; files: string[] } | { ok: false; failure: ProfileFailure } {
  const fail = (
    reason: string,
    place: string,
    code: ProfileFailure["code"] = "INVALID_PROFILE",
  ) => ({
    ok: false as const,
    failure: { code, reason, place },
  });
  let table: Record<string, unknown>;
  try {
    table = parseToml(text) as Record<string, unknown>;
  } catch (error) {
    const at = error as { line?: number; column?: number };
    const place =
      at.line !== undefined ? `${profilePath}:${at.line}:${at.column ?? 1}` : profilePath;
    return fail(`This is not valid TOML (${tomlProblem(error)}). Correct the syntax.`, place);
  }
  if (table.policy !== undefined) {
    return fail(
      "Box does not take the key `policy`. List your policy files under `policies` instead, " +
        'such as policies = ["policy.dw"].',
      placeOfKey(text, profilePath, "policy"),
      "UNSUPPORTED_POLICY_KEY",
    );
  }
  const named = table.policies ?? [];
  const place = placeOfKey(text, profilePath, "policies");
  const folder = posix.dirname(profilePath);
  if (!Array.isArray(named) || !named.every((file) => typeof file === "string" && file !== "")) {
    return fail(
      '`policies` must be a list of policy file paths, such as ["policy.dw"]. Correct it.',
      place,
    );
  }
  const files: string[] = [];
  for (const file of named as string[]) {
    const normal = posix.normalize(file.replace(/\\/g, "/"));
    if (posix.isAbsolute(normal) || normal === ".." || normal.startsWith("../")) {
      return fail(
        `\`policies\` names ${JSON.stringify(file)}, which is outside ${folder}/. Move the file ` +
          `into ${folder}/, and name it from there.`,
        place,
      );
    }
    if (files.includes(normal)) {
      return fail(`\`policies\` names ${JSON.stringify(file)} twice. Remove one of them.`, place);
    }
    files.push(normal);
  }
  return { ok: true, files };
}

/**
 * Where the profile `text`, at `profilePath` from the project root, sets each `[egress.<name>]`
 * and `[mcp.<name>]` entry, `packs`, and `policies`: the first line of each, by its table header,
 * its dotted key, or its key under `[egress]` or `[mcp]`.
 */
export function profilePlaces(text: string, profilePath: string): ProfilePlaces {
  const entries = new Map<string, string>();
  const keys = new Map<string, string>();
  let table: string[] = [];
  text.split("\n").forEach((line, index) => {
    const place = `${profilePath}:${index + 1}:${line.search(/\S/) + 1}`;
    const header = /^\s*\[\[?([^\]]*)\]\]?\s*(?:#.*)?$/.exec(line);
    const assignment = header ? undefined : /^\s*([^\s=#[][^=]*?)\s*=/.exec(line);
    if (!header && !assignment) return;
    const path = header ? keyPath(header[1]!) : [...table, ...keyPath(assignment![1]!)];
    if (header) table = path;
    const [first, second] = path;
    if ((first === "egress" || first === "mcp") && second !== undefined) {
      const key = `${first}.${second}`;
      if (!entries.has(key)) entries.set(key, place);
    }
    if (!header && path.length === 1 && !keys.has(first!)) keys.set(first!, place);
  });
  return {
    entries,
    ...(keys.has("packs") && { packs: keys.get("packs")! }),
    ...(keys.has("policies") && { policies: keys.get("policies")! }),
  };
}

/** The parts of a TOML key: `egress."dot.name".secret` as `["egress", "dot.name", "secret"]`. */
function keyPath(text: string): string[] {
  const parts: string[] = [];
  const part = /\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*(?:\.|$)/y;
  let match: RegExpExecArray | null;
  while (part.lastIndex < text.length && (match = part.exec(text)) !== null) {
    parts.push(match[1] ?? match[2] ?? match[3]!);
  }
  return parts;
}

/** `<profilePath>:<line>:<column>` of the first line that sets `key`, or the file. */
function placeOfKey(text: string, profilePath: string, key: string): string {
  const lines = text.split("\n");
  const index = lines.findIndex((line) => new RegExp(`^\\s*${key}\\s*=`).test(line));
  if (index === -1) return profilePath;
  return `${profilePath}:${index + 1}:${lines[index]!.search(/\S/) + 1}`;
}

/** The TOML reader's message, without its "Invalid TOML document:" start and its excerpt. */
function tomlProblem(error: unknown): string {
  const message = ((error as { message?: string }).message ?? String(error)).split("\n")[0]!;
  return message.replace(/^Invalid TOML document:\s*/, "");
}

function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
