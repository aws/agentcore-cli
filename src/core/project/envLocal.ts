import { join } from "node:path";
import { atomicWrite, readTextFile } from "../../io";
import type { EnvLocalEntry } from "../../handlers/project/types";

/** The project-relative path of the local secrets file (read by `agentcore dev`). */
export const ENV_LOCAL_RELATIVE_PATH = join("agentcore", ".env.local");

const KEY_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

/**
 * Appends entries to a .env-format file, creating it when missing. Keys that
 * already exist are never overwritten so user-managed values survive re-runs.
 */
export async function upsertEnvLocalEntries(
  envPath: string,
  entries: EnvLocalEntry[],
): Promise<{ written: string[]; skipped: string[] }> {
  const existing = await readOrEmpty(envPath);
  const existingKeys = new Set(
    existing
      .split("\n")
      .map((line) => KEY_LINE.exec(line)?.[1])
      .filter((key) => key !== undefined),
  );

  const written: string[] = [];
  const skipped: string[] = [];
  let content = existing;
  for (const entry of entries) {
    if (existingKeys.has(entry.key)) {
      skipped.push(entry.key);
      continue;
    }
    const separator = content === "" || content.endsWith("\n") ? "" : "\n";
    content += `${separator}# ${entry.comment}\n${entry.key}=${entry.value ?? ""}\n`;
    written.push(entry.key);
  }

  if (written.length > 0) await atomicWrite(envPath, content);
  return { written, skipped };
}

/**
 * Makes sure the project's .gitignore keeps .env.local out of version control.
 * Returns true when the file was created or amended.
 */
export async function ensureGitignoreCoversEnvLocal(rootPath: string): Promise<boolean> {
  const gitignorePath = join(rootPath, ".gitignore");
  const existing = await readOrEmpty(gitignorePath);
  // Literal-line match, not full gitignore pattern semantics; a matcher
  // library is warranted only if projects grow exotic ignore rules.
  const covered = existing
    .split("\n")
    .map((line) => line.trim())
    .some((line) => line === ".env.local" || line === ".env*.local");
  if (covered) return false;

  const separator = existing === "" || existing.endsWith("\n") ? "" : "\n";
  await atomicWrite(
    gitignorePath,
    `${existing}${separator}# Local secrets (added by agentcore; never commit)\n.env.local\n`,
  );
  return true;
}

async function readOrEmpty(path: string): Promise<string> {
  try {
    return await readTextFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}
