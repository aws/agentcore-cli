import { homedir } from "node:os";
import { join } from "node:path";
import { readTextFile } from "../io";

// DEFAULT_REGION is the final fallback when no region is configured anywhere.
export const DEFAULT_REGION = "us-east-1";

/**
 * Reads the `region` setting for the active profile from the shared AWS config
 * file (~/.aws/config, or $AWS_CONFIG_FILE). An explicit profile takes precedence
 * over $AWS_PROFILE, then "default". Returns undefined if the file, profile, or setting is absent —
 * never throws.
 */
export async function regionFromConfigFile(selectedProfile?: string): Promise<string | undefined> {
  const path = process.env.AWS_CONFIG_FILE || join(homedir(), ".aws", "config");
  let text: string;
  try {
    text = await readTextFile(path);
  } catch {
    return undefined; // no config file
  }

  // In ~/.aws/config the default profile is "[default]" and named profiles are
  // "[profile name]".
  const profile = selectedProfile ?? (process.env.AWS_PROFILE || "default");
  const wanted = profile === "default" ? "default" : `profile ${profile}`;

  let inSection = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[") && line.endsWith("]")) {
      inSection = line.slice(1, -1).trim() === wanted;
      continue;
    }
    if (inSection && line.startsWith("region")) {
      const value = line.split("=")[1]?.trim();
      if (value) return value;
    }
  }
  return undefined;
}

/**
 * Picks the effective AWS region: an explicit --region value, then
 * AWS_REGION / AWS_DEFAULT_REGION, then the shared config file, finally
 * DEFAULT_REGION. It always resolves to a value.
 */
export async function resolveRegion(
  flagRegion: string | undefined,
  profile?: string,
): Promise<string> {
  return (
    flagRegion ||
    process.env.AWS_REGION ||
    process.env.AWS_DEFAULT_REGION ||
    (await regionFromConfigFile(profile)) ||
    DEFAULT_REGION
  );
}

/**
 * Best-effort extraction of a `--region <value>` / `--region=<value>` argument
 * from raw argv, for callers that run outside the command router (telemetry).
 * Not a full argv parser: a literal "--region" appearing as another flag's
 * value can mislead it, which is acceptable for its only consumer — the China
 * telemetry gate, where a wrong match can only disable telemetry, never enable
 * it.
 */
export function regionFlagFromArgv(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--region") return argv[i + 1];
    if (arg.startsWith("--region=")) return arg.slice("--region=".length);
  }
  return undefined;
}

/** Profile selection for region-dependent work that happens before command routing. */
export function profileFlagFromArgv(argv: readonly string[]): string | undefined {
  let profile: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") break;
    if (arg === "--profile") profile = argv[++i];
    else if (arg.startsWith("--profile=")) profile = arg.slice("--profile=".length);
  }
  return profile;
}
