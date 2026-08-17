import { homedir } from "node:os";
import { join, sep } from "node:path";

// The CLI keeps its log beside the rest of its state, under the user's home.
const LOG_DIRECTORY = [".agentcore", "logs"];

/**
 * The file path prefix the CLI's log rotates on.
 *
 * Everything that needs the log's location reads it from here — the entrypoint that
 * creates the logger, and the commands that tell the user where to look — so the
 * location printed is always the one being written to.
 */
export function logFilePrefix(home: string = homedir()): string {
  return join(home, ...LOG_DIRECTORY, "output");
}

/**
 * The file a logger rotating on `prefix` writes `at`'s messages to.
 *
 * Mirrors what {@link createFileLogger} configures its transport with:
 * `${prefix}-%DATE%` plus a `.log` extension, with `YYYY-MM-DD` in local time.
 */
export function rotatedLogFile(prefix: string, at: Date): string {
  const month = String(at.getMonth() + 1).padStart(2, "0");
  const day = String(at.getDate()).padStart(2, "0");
  return `${prefix}-${at.getFullYear()}-${month}-${day}.log`;
}

/**
 * Where to tell the user their detailed logs are, written as they would type it.
 *
 * Shortened to `~` rather than made relative to the working directory: the log lives
 * under the user's home, so a path relative to a project directory is a run of `../`
 * that stops being correct as soon as they cd.
 */
export function detailedLogLocation(at: Date = new Date(), home: string = homedir()): string {
  const path = rotatedLogFile(logFilePrefix(home), at);
  return path.startsWith(`${home}${sep}`) ? `~${path.slice(home.length)}` : path;
}
