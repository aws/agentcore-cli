import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import { enclosingProjectRoot } from "../core/project/fsUtils";

// A project's log joins the rest of its CLI state under agentcore/.cli, which the
// scaffolded .gitignore excludes. Outside a project there is nothing to write into, so
// the log falls back beside the CLI's global state.
const PROJECT_LOG_DIRECTORY = ["agentcore", ".cli", "logs"];
const HOME_LOG_DIRECTORY = [".agentcore", "logs"];

// What a run with no command to name it after — a bare `agentcore` — is filed under.
const CLI_NAME = "agentcore";

type Location = {
  /** Where the command was run from; decides whether a project owns the log. */
  cwd?: string;
  home?: string;
  /** `process.argv`, as the router is handed it; names the command the log belongs to. */
  argv?: string[];
};

/**
 * The command a log belongs to: `deploy`, for `agentcore project deploy --target prod`.
 *
 * Only the last segment of the command path is wanted, so this needs no knowledge of any
 * flag: the path is the first unbroken run of non-flag tokens, less its first token when
 * a flag precedes the run, since that token may be the flag's value.
 */
function commandName(argv: string[]): string {
  const tokens = argv.slice(2);
  const first = tokens.findIndex((token) => !token.startsWith("-"));
  if (first === -1) return CLI_NAME;
  const flagged = tokens.findIndex((token, index) => index > first && token.startsWith("-"));
  const path = tokens.slice(first === 0 ? 0 : first + 1, flagged === -1 ? undefined : flagged);
  return path.at(-1) ?? CLI_NAME;
}

/**
 * The prefix the rotating log file is named from: a directory per command holding that
 * command's runs, so reading a deploy's log means reading only deploys.
 */
export function logFilePrefix({
  cwd = process.cwd(),
  home = homedir(),
  argv = process.argv,
}: Location = {}): string {
  const command = commandName(argv);
  const projectRoot = enclosingProjectRoot(cwd);
  return projectRoot
    ? join(projectRoot, ...PROJECT_LOG_DIRECTORY, command, command)
    : join(home, ...HOME_LOG_DIRECTORY, command, command);
}

export function rotatedLogFile(prefix: string, at: Date): string {
  const month = String(at.getMonth() + 1).padStart(2, "0");
  const day = String(at.getDate()).padStart(2, "0");
  return `${prefix}-${at.getFullYear()}-${month}-${day}.log`;
}

/**
 * The log file, spelled the shortest way that stays correct: relative for a project's
 * log, and `~`-shortened for the fallback, where relative would be a run of `../` that
 * breaks on the next cd.
 */
export function detailedLogLocation({
  at = new Date(),
  cwd = process.cwd(),
  home = homedir(),
  argv = process.argv,
}: Location & { at?: Date } = {}): string {
  const path = rotatedLogFile(logFilePrefix({ cwd, home, argv }), at);
  if (enclosingProjectRoot(cwd)) return relative(cwd, path);
  return path.startsWith(`${home}${sep}`) ? `~${path.slice(home.length)}` : path;
}
