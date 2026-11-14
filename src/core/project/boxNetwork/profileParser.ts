/**
 * Reads the network inputs of a box profile from Box's own resolution of it: the `[egress]` and
 * `[mcp]` tables of the `box.toml` that `box profile show --full` prints. The profile's own
 * `policies` name the policy files that build stages beside the AgentCore Runtime profile.
 */
import { posix } from "node:path";
import { parse as parseToml } from "smol-toml";

/** The box profile, from the project root. */
export const BOX_PROFILE_PATH = ".box/profile.toml";

/** Where a failure of the `box.toml` that Box resolves the profile to is. */
const RESOLVED_BOX_TOML = "the box.toml of `box profile show`";

export interface ParsedProfile {
  /** `[egress]` as Box resolves it, with each route that Box writes only as rules. */
  readonly egress: Record<string, unknown>;
  readonly mcp: Record<string, unknown>;
  /** The profile's own policy files, relative to its folder, in the order it names them. */
  readonly policyFiles: readonly string[];
}

/** A failure of the profile, or of Box's resolution of it, at its line when one is known. */
export interface ProfileFailure {
  readonly code: "INVALID_PROFILE" | "UNSUPPORTED_POLICY_KEY";
  readonly reason: string;
  readonly place: string;
}

/** The `[egress]` and `[mcp]` tables of the `box.toml` that Box resolves the profile to. */
export function parseResolvedProfile(
  boxToml: string,
  policyFiles: readonly string[],
): { readonly profile: ParsedProfile; readonly failures: readonly ProfileFailure[] } {
  const fail = (reason: string) => ({
    profile: { egress: {}, mcp: {}, policyFiles },
    failures: [{ code: "INVALID_PROFILE" as const, reason, place: RESOLVED_BOX_TOML }],
  });
  let table: Record<string, unknown>;
  try {
    table = parseToml(boxToml) as Record<string, unknown>;
  } catch (error) {
    return fail(firstLine(error));
  }
  for (const key of ["egress", "mcp"] as const) {
    if (table[key] !== undefined && !isTable(table[key])) return fail(`\`${key}\` is not a table`);
  }
  return {
    profile: {
      egress: (table.egress as Record<string, unknown> | undefined) ?? {},
      mcp: (table.mcp as Record<string, unknown> | undefined) ?? {},
      policyFiles,
    },
    failures: [],
  };
}

/**
 * The policy files that the box profile `text` names under `policies`, as Box reads them: files
 * inside the profile's folder, each named once. `agentcore dev` reads them with no box, so this
 * refuses the `policy` key, as box does.
 */
export function profilePolicyFiles(
  text: string,
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
      at.line !== undefined ? `${BOX_PROFILE_PATH}:${at.line}:${at.column ?? 1}` : BOX_PROFILE_PATH;
    return fail(firstLine(error), place);
  }
  if (table.policy !== undefined) {
    return fail(
      "the profile names `policy`, which the box CLI refuses; list the files under `policies`",
      placeOfKey(text, "policy"),
      "UNSUPPORTED_POLICY_KEY",
    );
  }
  const named = table.policies ?? [];
  const place = placeOfKey(text, "policies");
  if (!Array.isArray(named) || !named.every((file) => typeof file === "string" && file !== "")) {
    return fail("`policies` must name policy files, as nonempty paths", place);
  }
  const files: string[] = [];
  for (const file of named as string[]) {
    const normal = posix.normalize(file.replace(/\\/g, "/"));
    if (posix.isAbsolute(normal) || normal === ".." || normal.startsWith("../")) {
      return fail(
        `\`policies\` names ${JSON.stringify(file)}, which is outside the profile's folder`,
        place,
      );
    }
    if (files.includes(normal)) {
      return fail(`\`policies\` names ${JSON.stringify(file)} twice`, place);
    }
    files.push(normal);
  }
  return { ok: true, files };
}

/** `.box/profile.toml:<line>` of the first line that sets `key`, or the file when none does. */
function placeOfKey(text: string, key: string): string {
  const index = text.split("\n").findIndex((line) => new RegExp(`^\\s*${key}\\s*=`).test(line));
  return index === -1 ? BOX_PROFILE_PATH : `${BOX_PROFILE_PATH}:${index + 1}`;
}

function firstLine(error: unknown): string {
  return ((error as { message?: string }).message ?? String(error)).split("\n")[0]!;
}

function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
