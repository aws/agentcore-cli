import { homedir } from "node:os";
import { join, sep } from "node:path";

// The CLI's own state rather than a project's: every run writes here whichever project —
// or none — it was run in, so there is one directory to look in and one to attach a log
// from, and nothing about where a command ran can move the file somewhere else.
const LOG_DIRECTORY = [".agentcore", "logs"];

// Every log is named for the CLI rather than for the command that wrote it: the command
// is only knowable by parsing argv, and a guess there puts a file wherever a positional
// argument happens to point. The name still identifies the file once it has been copied
// out of the directory to be attached to a bug report.
const CLI_NAME = "agentcore";

// A run's log is named for when the run started, so one run is one file. Read once,
// rather than per call, so the logger that opens the file and the commands that print
// where it is name the same file however long the run takes.
const RUN_STARTED_AT = new Date();

type Location = {
  home?: string;
  /** When this run started; names its log file. */
  at?: Date;
};

// YYYYMMDD-HHMMSS, in local time: a run's logs sort chronologically by name, and a
// timestamp a user recognizes is what they match against when reporting a problem.
function runStamp(at: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const date = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}`;
  return `${date}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
}

/**
 * The file this run writes its log to: one file per run, so reading a deploy's log means
 * reading that deploy and nothing else.
 */
export function logFilePath({ home = homedir(), at = RUN_STARTED_AT }: Location = {}): string {
  return join(home, ...LOG_DIRECTORY, `${CLI_NAME}-${runStamp(at)}.log`);
}

/**
 * The log file as a command prints it: `~`-shortened, where a relative path would be a
 * run of `../` that stops being correct after the next cd.
 */
export function detailedLogLocation(location: Location = {}): string {
  const { home = homedir() } = location;
  const path = logFilePath({ ...location, home });
  return path.startsWith(`${home}${sep}`) ? `~${path.slice(home.length)}` : path;
}
