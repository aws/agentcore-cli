import { existsSync } from "node:fs";
import { cp, mkdir, rename, rm, rmdir } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import type { FileChange } from "../../../handlers/project/migrate/types";

/**
 * Where the v0 files a migration replaces are kept, relative to the project root,
 * until a stack is refactored (after which they can't come back) or the migration
 * completes.
 */
export const BACKUP_RELATIVE_PATH = "agentcore/.cli/migrate-backup";

const CDK_RELATIVE_PATH = join("agentcore", "cdk");

/** Writing the files failed, and so did putting back what had been written. */
export class FilesRestoreError extends Error {
  constructor(
    readonly original: Error,
    readonly restoreError: Error,
  ) {
    super(`${original.message}; then restoring the files failed: ${restoreError.message}`);
    this.name = "FilesRestoreError";
  }
}

/** Undoes or keeps a set of file writes. */
export type ProjectFilesBackup = {
  /**
   * Puts every file back as it was before the writes. Tries every step even when
   * one fails, then throws the failures together; the backup is kept until
   * everything is back.
   */
  restore(): Promise<void>;
  /** Keeps the writes and deletes the backup. */
  discard(): Promise<void>;
};

/**
 * Writes the migrated project from the workspace into the project: v1's vended
 * CDK app replaces agentcore/cdk wholesale (the v0 app, with its installed
 * dependencies, is moved aside), and every other changed file is copied over from
 * the workspace or deleted. The CDK app is written fresh by `writeCdkApp` rather
 * than copied, because the workspace's copy was installed and synthesized (and its
 * library may have been overridden for testing). Each file is backed up first,
 * under agentcore/.cli (which git ignores), so a later failure can put the project
 * back exactly; agentcore.json is written last, so until it is the project still
 * reads as v0.
 */
export async function writeMigratedFiles(input: {
  rootPath: string;
  workspaceDirectory: string;
  changes: FileChange[];
  /** Writes v1's vended CDK app into the (missing) directory given. */
  writeCdkApp: (cdkDirectory: string) => Promise<void>;
}): Promise<ProjectFilesBackup> {
  const { rootPath, workspaceDirectory } = input;
  const backup = join(rootPath, BACKUP_RELATIVE_PATH);
  await rm(backup, { recursive: true, force: true });
  await mkdir(backup, { recursive: true });

  const files = input.changes
    .filter((change) => !isUnder(change.path, CDK_RELATIVE_PATH))
    // agentcore.json last: an interrupted write leaves a project that is still v0.
    .sort((a, b) => Number(isSpec(a.path)) - Number(isSpec(b.path)));
  const written: FileChange[] = [];
  /** Directories the writes created, outermost first; restore removes them again. */
  const createdDirectories: string[] = [];
  /** Directories the writes emptied and removed; restore recreates them. */
  const removedDirectories: string[] = [];
  let cdkMoved = false;

  const restore = async () => {
    const failures: string[] = [];
    const attempt = async (what: string, step: () => Promise<unknown>) => {
      try {
        await step();
      } catch (error) {
        failures.push(`${what}: ${(error as Error).message}`);
      }
    };
    for (const change of [...written].reverse()) {
      const target = join(rootPath, change.path);
      await attempt(change.path, async () => {
        if (change.kind === "added") {
          await rm(target, { force: true });
        } else {
          await mkdir(dirname(target), { recursive: true });
          await cp(join(backup, "files", change.path), target);
        }
      });
    }
    for (const directory of [...createdDirectories].reverse()) {
      // Only if still empty: anything else in it isn't the migration's.
      await rmdir(directory).catch(() => {});
    }
    for (const directory of removedDirectories) {
      await attempt(relative(rootPath, directory), () => mkdir(directory, { recursive: true }));
    }
    if (cdkMoved) {
      const cdk = join(rootPath, CDK_RELATIVE_PATH);
      await attempt(CDK_RELATIVE_PATH, async () => {
        // Retried: a freshly installed node_modules can be busy for a moment on Windows.
        await rm(cdk, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        if (existsSync(join(backup, "cdk"))) await rename(join(backup, "cdk"), cdk);
      });
    }
    if (failures.length > 0) {
      throw new Error(
        `${failures.length} ${failures.length === 1 ? "path" : "paths"} couldn't be put back (${failures.join("; ")})`,
      );
    }
    await rm(backup, { recursive: true, force: true });
  };

  try {
    const cdk = join(rootPath, CDK_RELATIVE_PATH);
    if (existsSync(cdk)) await rename(cdk, join(backup, "cdk"));
    cdkMoved = true;
    await input.writeCdkApp(cdk);

    for (const change of files) {
      const target = join(rootPath, change.path);
      if (change.kind !== "added") {
        const saved = join(backup, "files", change.path);
        await mkdir(dirname(saved), { recursive: true });
        await cp(target, saved);
      }
      written.push(change);
      if (change.kind === "removed") {
        await rm(target, { force: true });
        removedDirectories.push(...(await removeEmptyParents(rootPath, dirname(target))));
      } else {
        createdDirectories.push(...(await makeDirectories(rootPath, dirname(target))));
        await cp(join(workspaceDirectory, change.path), target);
      }
    }
  } catch (error) {
    try {
      await restore();
    } catch (restoreError) {
      throw new FilesRestoreError(error as Error, restoreError as Error);
    }
    throw error;
  }
  return { restore, discard: () => rm(backup, { recursive: true, force: true }) };
}

/**
 * Puts the v0 files back from the backup a migration stopped part-way through
 * writing left, using the changes its record lists: an added file is deleted, a
 * modified or removed one is copied back if the backup has it (if not, it was
 * never touched), and the v0 CDK app is moved back. Empty directories the writes
 * created are left. Tries every step, then throws the failures together; the
 * backup is deleted only once everything is back.
 */
export async function restoreFromBackup(rootPath: string, changes: FileChange[]): Promise<void> {
  const backup = join(rootPath, BACKUP_RELATIVE_PATH);
  const failures: string[] = [];
  const attempt = async (what: string, step: () => Promise<unknown>) => {
    try {
      await step();
    } catch (error) {
      failures.push(`${what}: ${(error as Error).message}`);
    }
  };
  for (const change of changes) {
    if (isUnder(change.path, CDK_RELATIVE_PATH)) continue;
    const target = join(rootPath, change.path);
    await attempt(change.path, async () => {
      if (change.kind === "added") {
        await rm(target, { force: true });
        return;
      }
      const saved = join(backup, "files", change.path);
      if (!existsSync(saved)) return;
      await mkdir(dirname(target), { recursive: true });
      await cp(saved, target);
    });
  }
  if (existsSync(join(backup, "cdk"))) {
    const cdk = join(rootPath, CDK_RELATIVE_PATH);
    await attempt(CDK_RELATIVE_PATH, async () => {
      await rm(cdk, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      await rename(join(backup, "cdk"), cdk);
    });
  }
  if (failures.length > 0) {
    throw new Error(
      `${failures.length} ${failures.length === 1 ? "path" : "paths"} couldn't be put back (${failures.join("; ")})`,
    );
  }
  await rm(backup, { recursive: true, force: true });
}

/** Deletes a migration's backup of the v0 files. */
export async function discardBackup(rootPath: string): Promise<void> {
  await rm(join(rootPath, BACKUP_RELATIVE_PATH), { recursive: true, force: true });
}

function isUnder(path: string, directory: string): boolean {
  const normalized = path.split("/").join(sep);
  return normalized === directory || normalized.startsWith(`${directory}${sep}`);
}

function isSpec(path: string): boolean {
  return path === "agentcore/agentcore.json";
}

/** Creates `directory` and any missing parents; returns the ones it created, outermost first. */
async function makeDirectories(rootPath: string, directory: string): Promise<string[]> {
  const missing: string[] = [];
  for (let current = directory; current !== rootPath && !existsSync(current);) {
    missing.unshift(current);
    current = dirname(current);
  }
  await mkdir(directory, { recursive: true });
  return missing;
}

/**
 * Deletes `directory` and its parents while they're empty, stopping at the
 * project root; returns the ones it deleted, deepest first.
 */
async function removeEmptyParents(rootPath: string, directory: string): Promise<string[]> {
  const removed: string[] = [];
  for (let current = directory; current !== rootPath && current.startsWith(rootPath);) {
    try {
      await rmdir(current);
    } catch {
      // Not empty (or already gone): nothing above it can be empty either.
      break;
    }
    removed.push(current);
    current = dirname(current);
  }
  return removed;
}
