import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import { enclosingProjectRoot } from "../core/project/fsUtils";

// A project's log joins the rest of its CLI state under agentcore/.cli, which the
// scaffolded .gitignore excludes. Outside a project there is nothing to write into, so
// the log falls back beside the CLI's global state.
const PROJECT_LOG_DIRECTORY = ["agentcore", ".cli", "logs"];
const HOME_LOG_DIRECTORY = [".agentcore", "logs"];

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
  /** Where the command was run from; decides whether a project owns the log. */
  cwd?: string;
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
export function logFilePath({
  cwd = process.cwd(),
  home = homedir(),
  at = RUN_STARTED_AT,
}: Location = {}): string {
  const file = `${CLI_NAME}-${runStamp(at)}.log`;
  const projectRoot = enclosingProjectRoot(cwd);
  return projectRoot
    ? join(projectRoot, ...PROJECT_LOG_DIRECTORY, file)
    : join(home, ...HOME_LOG_DIRECTORY, file);
}

/**
 * The log file, spelled the shortest way that stays correct: relative for a project's
 * log, and `~`-shortened for the fallback, where relative would be a run of `../` that
 * breaks on the next cd.
 */
export function detailedLogLocation(location: Location = {}): string {
  const { cwd = process.cwd(), home = homedir() } = location;
  const path = logFilePath({ ...location, cwd, home });
  if (enclosingProjectRoot(cwd)) return relative(cwd, path);
  return path.startsWith(`${home}${sep}`) ? `~${path.slice(home.length)}` : path;
}
