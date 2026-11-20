/**
 * The text of a derived AgentCore Runtime box profile: a header comment, then the profile as TOML.
 * smol-toml writes each key, and the profile's own key order stays.
 */
import { stringify } from "smol-toml";
import type { TomlTable } from "./types";

/** The text of `profile`, after the comment lines of `header`. */
export function serializeRuntimeProfile(
  profile: Readonly<TomlTable>,
  header: readonly string[] = [],
): string {
  const comments = header.map((line) => `# ${line}\n`).join("");
  return `${comments}${stringify(profile)}\n`;
}
