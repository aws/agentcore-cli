import { rm } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite, readTextFile } from "../../io";
import type { EnvLocalEntry } from "../../handlers/project/types";

/** The project-relative path of the local secrets file (read by `agentcore dev`). */
export const ENV_LOCAL_RELATIVE_PATH = join("agentcore", ".env.local");

const KEY_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

/**
 * The project's `.env.local` secrets file, edited transactionally. `upsert`
 * appends entries (never overwriting an existing key) and snapshots the prior
 * state so `rollback` can undo the write if a later step in the same operation
 * fails. Mirrors the class shape of {@link SourceResolver} so callers hold one
 * object and reverse its effect, rather than tracking loose paths.
 */
export class EnvLocalFile {
  // undefined: upsert has not written; null: file did not exist before the
  // write; string: the file's content before the write.
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
  async upsert(entries: EnvLocalEntry[]): Promise<{ written: string[]; skipped: string[] }> {
    const existing = await readOrNull(this.path);
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
      content += `${separator}# ${entry.comment}\n${entry.key}=${entry.value ?? ""}\n`;
      written.push(entry.key);
    }

    if (written.length > 0) {
      this.snapshot = existing;
      await atomicWrite(this.path, content);
    }
    return { written, skipped };
  }

  /** Restores the file to its pre-`upsert` state; a no-op when `upsert` wrote nothing. */
  async rollback(): Promise<void> {
    if (this.snapshot === undefined) return;
    if (this.snapshot === null) await rm(this.path, { force: true });
    else await atomicWrite(this.path, this.snapshot);
  }
}

/** Reads a file, returning null when it does not exist so callers can tell empty from absent. */
async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readTextFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
