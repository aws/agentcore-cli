import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { parse as parseToml } from "smol-toml";
import { hasValue } from "../project/boxProfileEgress";
import { ENV_LOCAL_RELATIVE_PATH } from "../project/envLocal";
import { BOX_PROFILE_FILE, boxProfilePath } from "../project/templates/boxProfile";

const ENV_SCHEME = "env://";

/** A variable the box profile reads a key from, and the table that reads it. */
export type BoxDevSecretVariable = { readonly variable: string; readonly table: string };

/** The keys the box profile reads from the environment, as dev hands them to `box run`. */
export type BoxDevSecrets = {
  /** Each variable with its value, for `box run`'s environment. */
  readonly env: Record<string, string>;
  /** Each variable that is unset or blank; box refuses to start without it. */
  readonly missing: readonly BoxDevSecretVariable[];
};

/**
 * The variables that the project's box profile reads its keys from: each `env://<VAR>` secret of
 * an `[egress.<name>]` route or an `[mcp.<name>]` server, with its value in `env`. Dev hands these
 * to `box run` as they are and writes none of them anywhere. A CodeZip agent's `box run` inherits
 * the whole environment already; a box container gets them in its environment, since it gets
 * nothing else from the host's. Only the profile's own tables count: a pack's variable, such as
 * box/bedrock's `AWS_BEARER_TOKEN_BEDROCK`, is not the profile author's to pass. A profile that
 * does not parse has none here; `box run` reports it.
 */
export async function boxDevSecrets(
  projectRoot: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<BoxDevSecrets> {
  const profile = boxProfilePath(projectRoot);
  if (!existsSync(profile)) return { env: {}, missing: [] };
  const table = parseProfile(await readFile(profile, "utf-8"));

  const found: Record<string, string> = {};
  const missing: BoxDevSecretVariable[] = [];
  for (const kind of ["egress", "mcp"] as const) {
    for (const [name, entry] of Object.entries(tableOf(table[kind]))) {
      const ref = (entry as { secret?: { ref?: unknown } } | null)?.secret?.ref;
      if (typeof ref !== "string" || !ref.startsWith(ENV_SCHEME)) continue;
      const variable = ref.slice(ENV_SCHEME.length);
      if (variable === "" || variable in found) continue;
      const value = env[variable];
      if (!hasValue(value)) {
        if (!missing.some((other) => other.variable === variable)) {
          missing.push({ variable, table: `[${kind}.${name}]` });
        }
        continue;
      }
      found[variable] = value;
    }
  }
  return { env: found, missing };
}

/** The warning dev shows for a variable the box profile reads that is not set. */
export function missingBoxSecretWarning({ variable, table }: BoxDevSecretVariable): string {
  return (
    `the box profile ${BOX_PROFILE_FILE} reads ${variable} for ${table}, but it is not set, and ` +
    `box does not start without it. Export it in this shell (export ${variable}=...) or put it ` +
    `in ${ENV_LOCAL_RELATIVE_PATH}, then restart dev.`
  );
}

function parseProfile(text: string): Record<string, unknown> {
  try {
    return parseToml(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function tableOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
