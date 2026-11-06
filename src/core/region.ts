import { homedir } from "node:os";
import { join } from "node:path";
import { readTextFile } from "../io";
import type { AwsCredentialSource } from "../handlers/project/types";

// DEFAULT_REGION is the final fallback when no region is configured anywhere.
export const DEFAULT_REGION = "us-east-1";

/** The shared config profile the AWS SDK reads: $AWS_PROFILE, else "default". */
export function activeProfile(): string {
  return process.env.AWS_PROFILE || "default";
}

/**
 * Where the default AWS SDK credential chain takes credentials from. It skips
 * access keys in the environment whenever AWS_PROFILE is set, so only a key
 * pair without AWS_PROFILE counts as environment credentials.
 */
export function activeCredentialSource(): AwsCredentialSource {
  if (
    !process.env.AWS_PROFILE &&
    process.env.AWS_ACCESS_KEY_ID &&
    process.env.AWS_SECRET_ACCESS_KEY
  ) {
    return { credentialSource: "environment" };
  }
  return { credentialSource: "profile", profile: activeProfile() };
}

/**
 * Reads the `region` setting for the active profile from the shared AWS config
 * file (~/.aws/config, or $AWS_CONFIG_FILE). The active profile is $AWS_PROFILE,
 * else "default". Returns undefined if the file, profile, or setting is absent —
 * never throws.
 */
export async function regionFromConfigFile(): Promise<string | undefined> {
  const path = process.env.AWS_CONFIG_FILE || join(homedir(), ".aws", "config");
  let text: string;
  try {
    text = await readTextFile(path);
  } catch {
    return undefined; // no config file
  }

  // In ~/.aws/config the default profile is "[default]" and named profiles are
  // "[profile name]".
  const profile = activeProfile();
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
export async function resolveRegion(flagRegion: string | undefined): Promise<string> {
  return (
    flagRegion ||
    process.env.AWS_REGION ||
    process.env.AWS_DEFAULT_REGION ||
    (await regionFromConfigFile()) ||
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
