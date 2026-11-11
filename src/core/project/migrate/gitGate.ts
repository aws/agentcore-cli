import { InvalidEnvironmentError, ProjectStateError } from "../../../errors";
import { ProcessFailedError, type ProcessRunner } from "../../../io";
import { REPORTS_RELATIVE_PATH } from "./reports";

/** The project spec as git sees it: repository-relative, always forward slashes. */
const PROJECT_SPEC_GIT_PATH = "agentcore/agentcore.json";

/** How many changed paths the dirty-tree error lists before summarizing the rest. */
export const MAX_LISTED_CHANGES = 10;

/** Why the git gate refused to let migrate run; carried in the thrown error's `meta.reason`. */
export type GitGateFailure =
  "git-not-installed" | "not-a-repository" | "spec-untracked" | "status-failed" | "dirty";

export type GitGateResult = {
  /** The project root the gate checked. */
  projectRoot: string;
};

/**
 * Checks that the project at `projectRoot` is safe to migrate in place: git is
 * installed, the project is inside a git work tree, agentcore/agentcore.json
 * is tracked, and nothing under the project directory has uncommitted changes.
 * Migrate rewrites project files, so this is what lets the user review the
 * result with `git diff` and undo it with git.
 *
 * Throws {@link InvalidEnvironmentError} when git can't run and
 * {@link ProjectStateError} for every repository precondition, each with an
 * actionable message and a {@link GitGateFailure} in `meta.reason`.
 */
export async function checkGitGate(
  runner: ProcessRunner,
  projectRoot: string,
): Promise<GitGateResult> {
  const git = (args: string[]) => runGit(runner, projectRoot, args);

  const insideWorkTree = await git(["rev-parse", "--is-inside-work-tree"]);
  if (!insideWorkTree.ok || insideWorkTree.output.trim() !== "true") {
    throw new ProjectStateError(
      "agentcore migrate requires the project to be in a git repository so you can review " +
        "and undo the changes. Run `git init` and commit your project first." +
        (insideWorkTree.ok ? "" : gitDetail(insideWorkTree.output)),
      { meta: { reason: "not-a-repository" satisfies GitGateFailure, projectRoot } },
    );
  }

  const tracked = await git(["ls-files", "--error-unmatch", PROJECT_SPEC_GIT_PATH]);
  if (!tracked.ok) {
    throw new ProjectStateError(
      `${PROJECT_SPEC_GIT_PATH} isn't committed to git. agentcore migrate needs your project ` +
        "committed so you can review and undo the changes. Commit your project " +
        "(for example `git add . && git commit`) and run agentcore migrate again.",
      { meta: { reason: "spec-untracked" satisfies GitGateFailure, projectRoot } },
    );
  }

  // --no-optional-locks keeps status from refreshing the index, so the check
  // never contends with a git process the user has running. Force untracked
  // files to be reported even when status.showUntrackedFiles is configured off.
  const status = await git([
    "--no-optional-locks",
    "status",
    "--porcelain",
    "--untracked-files=all",
    "--",
    ".",
    // Migrate's own reports, which a project's .gitignore may not cover.
    `:(exclude)${REPORTS_RELATIVE_PATH}`,
  ]);
  if (!status.ok) {
    throw new ProjectStateError(
      "Couldn't read the git status of the project." + gitDetail(status.output),
      { meta: { reason: "status-failed" satisfies GitGateFailure, projectRoot } },
    );
  }
  const changes = status.output.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (changes.length > 0) {
    throw new ProjectStateError(
      "Commit or stash your changes before migrating, so the migration is the only change " +
        `to review and undo. Uncommitted changes:\n${formatChanges(changes)}`,
      { meta: { reason: "dirty" satisfies GitGateFailure, projectRoot, changes } },
    );
  }

  return { projectRoot };
}

type GitOutcome = { ok: boolean; output: string };

/**
 * Runs `git -C <root> ...args`, capturing its output. A non-zero exit is a
 * normal answer (e.g. "not a repository"), returned rather than thrown; a git
 * that isn't on PATH becomes {@link InvalidEnvironmentError}.
 */
async function runGit(
  runner: ProcessRunner,
  projectRoot: string,
  args: string[],
): Promise<GitOutcome> {
  let output = "";
  try {
    await runner(["git", "-C", projectRoot, ...args], {
      cwd: projectRoot,
      onOutput: (chunk) => {
        output += chunk;
      },
    });
    return { ok: true, output };
  } catch (error) {
    if (isSpawnNotFound(error)) {
      throw new InvalidEnvironmentError(
        "git isn't installed or isn't on PATH. agentcore migrate uses git so you can review " +
          "and undo the changes. Install git (https://git-scm.com/downloads) and try again.",
        { cause: error, meta: { reason: "git-not-installed" satisfies GitGateFailure } },
      );
    }
    // git ran and said no; anything else (it couldn't start, or was aborted) propagates.
    if (error instanceof ProcessFailedError && error.meta.exitCode !== null) {
      return { ok: false, output };
    }
    throw error;
  }
}

/**
 * runProcess reports a spawn failure as a ProcessFailedError with no exit code.
 * Node words a missing executable as "spawn git ENOENT"; Bun (the compiled
 * binaries) as "Executable not found in $PATH".
 */
function isSpawnNotFound(error: unknown): boolean {
  return (
    error instanceof ProcessFailedError &&
    error.meta.exitCode === null &&
    /\bENOENT\b|Executable not found/.test(error.message)
  );
}

/** Appends git's own explanation when it isn't the plain "not a git repository". */
function gitDetail(gitOutput: string): string {
  const output = gitOutput.trim();
  if (!output || /not a git repository/i.test(output)) return "";
  return `\n\ngit reported:\n${output}`;
}

function formatChanges(changes: string[]): string {
  const listed = changes.slice(0, MAX_LISTED_CHANGES).map((line) => `  ${line}`);
  const hidden = changes.length - listed.length;
  if (hidden > 0) listed.push(`  ...and ${hidden} more`);
  return listed.join("\n");
}
