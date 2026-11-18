/**
 * Reads the network inputs of a box profile from Box's own resolution of it: the `[egress]` and
 * `[mcp]` tables of the `box.toml` that `box profile show --format json` prints, and its open
 * routes. The profile's own `policies` name the policy files that build stages beside the
 * AgentCore Runtime profile, and its own text places each entry, `packs`, and `policies` for a
 * message.
 */
import { posix } from "node:path";
import { parse as parseToml } from "smol-toml";
import type { ResolvedBoxProfile } from "../boxProfileResolver";
import { cloudWatchTelemetry, type CloudWatchTelemetry } from "./telemetry";

/** The packs the converter reads: `box/base` declares no route, and `box/bedrock` one. */
const KNOWN_PACKS: ReadonlySet<string> = new Set(["box/base", BOX_BEDROCK_PACK]);

export interface ParsedProfile {
  /** `[egress]`, with the route of `box/bedrock` merged under the profile's own. */
  readonly egress: Record<string, unknown>;
  readonly mcp: Record<string, unknown>;
  /** The policy files, relative to the profile's folder, in the order the profile names them. */
  readonly policyFiles: readonly string[];
}

export interface ParsedProfile {
  /** `[egress]` as Box resolves it, with each open route. */
  readonly egress: Record<string, unknown>;
  readonly mcp: Record<string, unknown>;
  /** The profile's own policy files, relative to its folder, in the order it names them. */
  readonly policyFiles: readonly string[];
  /** The CloudWatch targets of `[telemetry]` as Box resolves it; absent means none. */
  readonly telemetry?: readonly CloudWatchTelemetry[];
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
 * The `[egress]` and `[mcp]` tables of the `box.toml` that Box resolves the profile to, with each
 * open route after the routes of `[egress]`.
 */
export function parseResolvedProfile(
  { boxToml, openRoutes }: Pick<ResolvedBoxProfile, "boxToml" | "openRoutes">,
  policyFiles: readonly string[],
): { readonly profile: ParsedProfile; readonly failures: readonly ProfileFailure[] } {
  for (const key of ["egress", "mcp"] as const) {
    if (boxToml[key] !== undefined && !isTable(boxToml[key])) {
      const reason =
        `Box resolves \`${key}\` in this profile to a value that is not a table. Write each ` +
        `entry as a table, such as [${key}.github].`;
      return {
        profile: { egress: {}, mcp: {}, policyFiles },
        failures: [{ code: "INVALID_PROFILE", reason, place: BOX_PROFILE_PATH }],
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
      egress,
      mcp: (boxToml.mcp as Record<string, unknown> | undefined) ?? {},
      policyFiles,
      ...(telemetry.length > 0 && { telemetry }),
    },
    failures: [],
  };
}

/**
 * The network inputs of the box profile `text`, and every failure of the profile. `profilePath` is
 * the profile's path from the project root, which the failures name. `bedrockRegion` is the region
 * the AgentCore Runtime profile gives box/bedrock, when it replaces the profile's.
 */
export function profilePolicyFiles(
  text: string,
  profilePath: string,
  bedrockRegion?: string,
): {
  readonly profile: ParsedProfile;
  readonly failures: readonly ProfileFailure[];
} {
  const fail = (code: ProfileFailure["code"], reason: string, key?: string) => ({
    profile: EMPTY_PROFILE,
    failures: [{ code, reason, place: placeOfKey(text, profilePath, key) }],
  });
  let table: Record<string, unknown>;
  try {
    table = parseToml(text) as Record<string, unknown>;
  } catch (error) {
    const at = error as { line?: number; column?: number };
    const place =
      at.line !== undefined ? `${profilePath}:${at.line}:${at.column ?? 1}` : profilePath;
    const reason = (at.message ?? String(error)).split("\n")[0]!;
    return { profile: EMPTY_PROFILE, failures: [{ code: "INVALID_PROFILE", reason, place }] };
  }
  const packs = table.packs ?? [];
  if (!Array.isArray(packs) || !packs.every((pack) => typeof pack === "string")) {
    return fail("INVALID_PROFILE", "`packs` is not a list of pack names", "packs");
  }
  for (const key of ["egress", "mcp"] as const) {
    if (table[key] !== undefined && !isTable(table[key])) {
      return fail("INVALID_PROFILE", `\`${key}\` is not a table`, key);
    }
  }
  if (table.policy !== undefined) {
    return fail(
      "Box does not take the key `policy`. List your policy files under `policies` instead, " +
        'such as policies = ["policy.dw"].',
      placeOfKey(text, "policy"),
      "UNSUPPORTED_POLICY_KEY",
    );
  }
  const policyFiles = policyFilesOf(table);
  if (!policyFiles.ok) return fail("INVALID_PROFILE", policyFiles.reason, "policies");

  const failures: ProfileFailure[] = (packs as string[])
    .filter((pack) => !KNOWN_PACKS.has(pack))
    .map((pack) => ({
      code: "UNSUPPORTED_PACK" as const,
      reason:
        `it names the pack ${pack}, whose routes and rules build does not read; ` +
        "write its [egress] entries and rules into the profile, and remove the pack",
      place: placeOfKey(text, profilePath, "packs"),
    }));
  let egress: Record<string, unknown> = {};
  if ((packs as string[]).includes(BOX_BEDROCK_PACK)) {
    egress = bedrockPackEgress(table, bedrockRegion);
  }
  egress = merged(egress, (table.egress as Record<string, unknown> | undefined) ?? {});
  return {
    profile: {
      egress,
      mcp: (table.mcp as Record<string, unknown> | undefined) ?? {},
      policyFiles: policyFiles.files,
    },
    failures,
  };
}

/** `<profilePath>:<line>` of the first line that sets `key`, or the file when none does. */
function placeOfKey(text: string, profilePath: string, key: string | undefined): string {
  if (key === undefined) return profilePath;
  const index = text.split("\n").findIndex((line) => new RegExp(`^\\s*${key}\\s*=`).test(line));
  return index === -1 ? profilePath : `${profilePath}:${index + 1}`;
}

/**
 * The `[egress.bedrock]` route of `box/bedrock`: for `bedrockRegion`, the region the AgentCore
 * Runtime profile sets, else the region the profile's `[options]` set.
 */
function bedrockPackEgress(
  table: Record<string, unknown>,
  bedrockRegion: string | undefined,
): Record<string, unknown> {
  const options = isTable(table.options) ? table.options : {};
  const bedrock = isTable(options.bedrock) ? options.bedrock : {};
  const quoted = options["bedrock.region"];
  const region = bedrockRegion
    ? bedrockRegion
    : typeof bedrock.region === "string"
      ? bedrock.region
      : typeof quoted === "string"
        ? quoted
        : BOX_BEDROCK_PACK_DEFAULT_REGION;
  return {
    bedrock: {
      destinations: [`bedrock-runtime.${region}.amazonaws.com`],
      secret: { ref: BOX_BEDROCK_PACK_SECRET },
    },
  };
}

/** The profile's `policies`, as the box CLI reads it: files inside the profile's folder. */
function policyFilesOf(
  table: Record<string, unknown>,
): { ok: true; files: string[] } | { ok: false; reason: string } {
  const named = table.policies ?? [];
  const place = placeOfKey(text, "policies");
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
        `\`policies\` names ${JSON.stringify(file)}, which is outside .box/. Move the file into ` +
          ".box/, and name it from there.",
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
 * Where the profile `text` sets each `[egress.<name>]` and `[mcp.<name>]` entry, `packs`, and
 * `policies`: the first line of each, by its table header, its dotted key, or its key under
 * `[egress]` or `[mcp]`.
 */
export function profilePlaces(text: string): ProfilePlaces {
  const entries = new Map<string, string>();
  const keys = new Map<string, string>();
  let table: string[] = [];
  text.split("\n").forEach((line, index) => {
    const place = `${BOX_PROFILE_PATH}:${index + 1}:${line.search(/\S/) + 1}`;
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

/** `.box/profile.toml:<line>:<column>` of the first line that sets `key`, or the file. */
function placeOfKey(text: string, key: string): string {
  const lines = text.split("\n");
  const index = lines.findIndex((line) => new RegExp(`^\\s*${key}\\s*=`).test(line));
  if (index === -1) return BOX_PROFILE_PATH;
  return `${BOX_PROFILE_PATH}:${index + 1}:${lines[index]!.search(/\S/) + 1}`;
}

/** The TOML reader's message, without its "Invalid TOML document:" start and its excerpt. */
function tomlProblem(error: unknown): string {
  const message = ((error as { message?: string }).message ?? String(error)).split("\n")[0]!;
  return message.replace(/^Invalid TOML document:\s*/, "");
}

function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
