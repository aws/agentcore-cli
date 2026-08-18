import { readdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

// The names the CLI writes its logs under: one file per run, and the daily file earlier
// versions rotated. Only these are pruned, so anything else a user keeps in the log
// directory is left where they put it.
const RUN_LOG = /^agentcore-\d{8}-\d{6}\.log$/;
const ROTATED_LOG = /^output-\d{4}-\d{2}-\d{2}\.log$/;

/**
 * How much history is kept. The byte ceiling is what the rotating file enforced before
 * one file per run replaced it (5 MB × 10); the count is generous against it because a
 * run's log is usually a few kilobytes, and one deploy's worth of history is worth more
 * than ten runs.
 */
export const RETENTION = { runs: 50, bytes: 50 * 1024 * 1024 };

/**
 * Deletes the logs of the oldest runs until what is left fits {@link RETENTION}, and
 * returns how many were deleted.
 *
 * The log of the run doing the pruning is always kept, however far over the ceiling it
 * takes the directory: a run cannot delete the file it is still writing to. That also
 * makes the byte ceiling approximate, since that file keeps growing after it is measured.
 *
 * Housekeeping, so nothing here is allowed to fail a command: a directory that cannot be
 * read prunes nothing, and a file that another run deleted first is not an error.
 */
export async function pruneOldLogs(currentLogFile: string, limits = RETENTION): Promise<number> {
  const directory = dirname(currentLogFile);

  let names: string[];
  try {
    names = (await readdir(directory)).filter(
      (name) => RUN_LOG.test(name) || ROTATED_LOG.test(name),
    );
  } catch {
    // No log has been written yet, so there is nothing to prune.
    return 0;
  }

  // Both names carry a zero-padded timestamp, so their digits alone sort by age — by name
  // would rank every `output-` file above every `agentcore-` one. A daily file's digits
  // stop at its date, which makes it older than any run of that date, as it is.
  const age = (name: string) => name.replace(/\D/g, "");
  const newestFirst = names.sort((a, b) => age(b).localeCompare(age(a)));

  const stale: string[] = [];
  let kept = 0;
  let bytes = 0;
  for (const name of newestFirst) {
    const path = join(directory, name);
    const size = await stat(path)
      .then((stats) => stats.size)
      .catch(() => 0);

    if (path !== currentLogFile && (kept >= limits.runs || bytes + size > limits.bytes)) {
      stale.push(path);
      continue;
    }
    kept += 1;
    bytes += size;
  }

  const deleted = await Promise.all(
    stale.map((path) =>
      rm(path, { force: true }).then(
        () => true,
        () => false,
      ),
    ),
  );
  return deleted.filter(Boolean).length;
}
