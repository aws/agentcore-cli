import { chmod, rm } from "node:fs/promises";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { atomicWrite, readTextFile } from "../../io";
import { InputValidationError } from "../../errors";
import type { EnvLocalEntry } from "../../handlers/project/types";

/** The project-relative path of the local secrets file (read by `agentcore dev`). */
export const ENV_LOCAL_RELATIVE_PATH = join("agentcore", ".env.local");

const KEY_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;
const SECRET_FILE_MODE = 0o600;

/**
 * The project's `.env.local` secrets file, edited transactionally. `insertIfNew`
 * appends entries (never overwriting an existing key) and snapshots the prior
 * state so `rollback` can undo the write if a later step in the same operation
 * fails. Mirrors the class shape of {@link SourceResolver} so callers hold one
 * object and reverse its effect, rather than tracking loose paths.
 */
export class EnvLocalFile {
  // undefined: no write yet; null: file did not exist before the write;
  // string: the file's content before the write.
  private snapshot?: string | null;

  constructor(private readonly rootPath: string) {}

  /** The absolute path of the secrets file. */
  get path(): string {
    return join(this.rootPath, ENV_LOCAL_RELATIVE_PATH);
  }

  /**
   * Appends entries, creating the file when missing. Keys that already exist
   * are left unchanged so user-managed values survive re-runs. Returns the keys
   * written and those skipped.
   */
  async insertIfNew(entries: EnvLocalEntry[]): Promise<{ written: string[]; skipped: string[] }> {
    const existing = await this.readOrNull();
    if (existing !== null) await this.enforcePermissions();
    const existingKeys = new Set(
      (existing ?? "")
        .split("\n")
        .map((line) => KEY_LINE.exec(line)?.[1])
        .filter((key) => key !== undefined),
    );

    const written: string[] = [];
    const skipped: string[] = [];
    let content = existing ?? "";
    for (const entry of entries) {
      if (existingKeys.has(entry.key)) {
        skipped.push(entry.key);
        continue;
      }
      const separator = content === "" || content.endsWith("\n") ? "" : "\n";
      // Each entry is two lines:  # <comment>\n<key>=<value>
      content += `${separator}# ${entry.comment}\n${entry.key}=${formatValue(entry.value)}\n`;
      written.push(entry.key);
    }

    if (written.length > 0) {
      this.snapshot = existing;
      await atomicWrite(this.path, content, { mode: SECRET_FILE_MODE });
    }
    return { written, skipped };
  }

  /**
   * Reads the file's entries as a key/value map, returning {} when the file
   * does not exist. Values are read back with the same parser `agentcore dev`
   * uses, so quoting written by {@link insertIfNew} round-trips.
   */
  async read(): Promise<Record<string, string | undefined>> {
    const content = await this.readOrNull();
    if (content === null) return {};
    return parseEnv(content);
  }

  /** Restores the file to its pre-write state; a no-op when nothing was written. */
  async rollback(): Promise<void> {
    if (this.snapshot === undefined) return;
    if (this.snapshot === null) await rm(this.path, { force: true });
    else await atomicWrite(this.path, this.snapshot, { mode: SECRET_FILE_MODE });
  }

  private async readOrNull(): Promise<string | null> {
    try {
      return await readTextFile(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async enforcePermissions(): Promise<void> {
    if (process.platform !== "win32") await chmod(this.path, SECRET_FILE_MODE);
  }
}

/**
 * Single-quotes a value so `node:util`'s `parseEnv` reads it back byte-for-byte.
 * Single quotes are literal in that parser, so no character needs escaping,
 * except a single quote itself, which the format cannot represent.
 */
function formatValue(value?: string): string {
  if (!value) return "";
  if (value.includes("'")) {
    throw new InputValidationError(
      "a secret value that contains a single quote (') cannot be written to " +
        ".env.local; supply it with a Secrets Manager reference instead",
    );
  }
  return `'${value}'`;
}
