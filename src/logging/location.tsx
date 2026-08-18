import { homedir } from "node:os";
import { join, sep } from "node:path";

// The CLI's own state rather than a project's: every run writes here whichever project —
// or none — it was run in, so there is one directory to look in and one log to attach to a
// bug report, and nothing about where a command ran can move the file somewhere else.
const LOG_DIRECTORY = [".agentcore", "logs"];

// What the rotating transport is handed. It appends the date and the extension itself, so
// the prefix is not a file: `logFilePath` spells the file that prefix produces.
const LOG_PREFIX = "output";

// The day the rotating transport opened a file for, read once at startup so every mention
// of the log within one run names the same file. A run that crosses midnight rotates into
// the next day's file, so this names where the run started writing rather than where it
// finished — the directory is right either way, and the run's first lines are here.
const RUN_STARTED_AT = new Date();

type Location = {
  home?: string;
  /** The day whose file the rotating transport is writing. */
  at?: Date;
};

// `datePattern: "YYYY-MM-DD"` in local time, which is what the transport defaults to.
function day(at: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/**
 * The prefix the rotating file transport names its files after: it writes
 * `<prefix>-<date>.log`, and a further `.<n>` when a day's log passes the size limit.
 */
export function logFilePrefix({ home = homedir() }: Location = {}): string {
  return join(home, ...LOG_DIRECTORY, LOG_PREFIX);
}

/** The file the rotating transport is writing for this run's day. */
export function logFilePath({ home, at = RUN_STARTED_AT }: Location = {}): string {
  return `${logFilePrefix({ home })}-${day(at)}.log`;
}

/**
 * Where to look for the detail a command left out of its own output, for printing: the
 * log file itself, with the home directory it sits under shortened to `~`.
 */
export function detailedLogLocation(location: Location = {}): string {
  const { home = homedir() } = location;
  const path = logFilePath({ ...location, home });
  return path.startsWith(`${home}${sep}`) ? `~${path.slice(home.length)}` : path;
}
