import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** A temp directory and a handler that restores the cwd and removes it. */
export type TempDirectory = { path: string; cleanup: () => Promise<void> };

/** Creates a temp directory, cds into it, and returns its realpath plus a cleanup handler. */
export async function inTempDirectory(prefix = "agentcore-project-"): Promise<TempDirectory> {
  const originalCwd = process.cwd();
  const directory = await mkdtemp(join(tmpdir(), prefix));
  process.chdir(directory);
  return {
    path: process.cwd(),
    cleanup: async () => {
      process.chdir(originalCwd);
      await rm(directory, { recursive: true, force: true });
    },
  };
}
