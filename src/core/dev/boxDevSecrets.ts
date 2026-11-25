import { parse as parseToml } from "smol-toml";
import { BoxEgressSecretSchema } from "../project/boxNetwork/egress";
import { hasValue } from "../project/boxProfileEgress";
import type { BoxKeySources } from "../project/boxProfileCredentials";
import { ENV_LOCAL_RELATIVE_PATH } from "../project/envLocal";

const ENV_SCHEME = "env://";
/** Box reads a `secret://` reference of a `[telemetry.<name>]` target as an `env://` one. */
const TELEMETRY_SCHEMES = [ENV_SCHEME, "secret://"] as const;

/** A variable the box profile reads a key from, and the table that reads it. */
export type BoxDevSecretVariable = { readonly variable: string; readonly table: string };

/** The keys the box profile reads from the environment, as dev hands them to `box run`. */
export type BoxDevSecrets = {
  /** Each variable with its value, for `box run`'s environment. */
  readonly env: Record<string, string>;
  /** Each variable that is unset or blank; box refuses to start without it. */
  readonly missing: readonly BoxDevSecretVariable[];
  /** Each variable that the shell and `.env.local` both set, to different values: box gets the shell's. */
  readonly shadowed: readonly BoxDevSecretVariable[];
};

/**
 * The variables that the box profile `profileText` reads its keys from: each `env://<VAR>` secret
 * of an `[egress.<name>]` route, an `[mcp.<name>]` server, or a `[telemetry.<name>]` target, and
 * each `secret://<VAR>` secret of a `[telemetry.<name>]` target, with its value as build picks it
 * ({@link BoxKeySources}): the shell's when it is set and not blank, else `.env.local`'s. On
 * Windows, where variable names are case-insensitive, the shell's `Github_Token` sets
 * `GITHUB_TOKEN`. Dev hands these to `box run` as they are and writes none of them anywhere. Only
 * the profile's own tables count: a pack's variable, such as @box/bedrock's
 * `AWS_BEARER_TOKEN_BEDROCK`, is not the profile author's to pass. A profile that does not parse
 * has none here; `box run` reports it.
 */
export function boxDevSecrets(
  profileText: string,
  sources: BoxKeySources,
  platform: NodeJS.Platform = process.platform,
): BoxDevSecrets {
  const table = parseProfile(profileText);
  const found: Record<string, string> = {};
  const missing: BoxDevSecretVariable[] = [];
  const shadowed: BoxDevSecretVariable[] = [];
  for (const kind of ["egress", "mcp", "telemetry"] as const) {
    for (const [name, entry] of Object.entries(tableOf(table[kind]))) {
      const ref = secretRef(kind, tableOf(entry).secret);
      const schemes = kind === "telemetry" ? TELEMETRY_SCHEMES : [ENV_SCHEME];
      const scheme = schemes.find((candidate) => ref?.startsWith(candidate));
      if (ref === undefined || scheme === undefined) continue;
      const variable = ref.slice(scheme.length);
      if (variable.trim() === "" || Object.hasOwn(found, variable)) continue;
      const fromShell = shellValue(sources.env, variable, platform);
      const fromFile = own(sources.envLocal, variable);
      const value = hasValue(fromShell) ? fromShell : fromFile;
      if (!hasValue(value)) {
        if (!missing.some((other) => other.variable === variable)) {
          missing.push({ variable, table: `[${kind}.${name}]` });
        }
        continue;
      }
      if (hasValue(fromShell) && hasValue(fromFile) && fromShell !== fromFile) {
        shadowed.push({ variable, table: `[${kind}.${name}]` });
      }
      found[variable] = value;
    }
  }
  return { env: found, missing, shadowed };
}

/** The warning dev shows for a variable that `profileFile`, the agent's box profile, reads and that is not set. */
export function missingBoxSecretWarning(
  profileFile: string,
  { variable, table }: BoxDevSecretVariable,
): string {
  return (
    `the box profile ${profileFile} reads ${variable} for ${table}, but it is not set, and ` +
    `box does not start without it. Export it in this shell (export ${variable}=...) or put it ` +
    `in ${ENV_LOCAL_RELATIVE_PATH}, then restart dev.`
  );
}

/**
 * The note dev shows for a variable that the shell and `.env.local` both set, to different
 * values. It names the variable and never a value.
 */
export function shadowedBoxSecretNote({ variable, table }: BoxDevSecretVariable): string {
  return (
    `${variable}, which ${table} of the box profile reads, is set in this shell and in ` +
    `${ENV_LOCAL_RELATIVE_PATH} to different values; box uses the shell's`
  );
}

/** The shell's value of `variable`, found by its name in any case on Windows, as Windows does. */
function shellValue(
  env: NodeJS.ProcessEnv,
  variable: string,
  platform: NodeJS.Platform,
): string | undefined {
  const exact = own(env, variable);
  if (exact !== undefined || platform !== "win32") return exact;
  const name = Object.keys(env).find((key) => key.toUpperCase() === variable.toUpperCase());
  return name === undefined ? undefined : own(env, name);
}

/** The value `env` itself holds for `name`, not one an Object property such as `constructor` gives. */
function own(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  return Object.hasOwn(env, name) ? env[name] : undefined;
}

/** The `secret.ref` of a table of `kind`: a route or a server by its schema, a telemetry target by its `ref`. */
function secretRef(kind: "egress" | "mcp" | "telemetry", secret: unknown): string | undefined {
  if (kind === "telemetry") {
    const ref = tableOf(secret).ref;
    return typeof ref === "string" ? ref : undefined;
  }
  const parsed = BoxEgressSecretSchema.safeParse(secret);
  return parsed.success ? parsed.data.ref : undefined;
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
