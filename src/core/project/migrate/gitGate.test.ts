import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InvalidEnvironmentError, ProjectStateError } from "../../../errors";
import { ProcessFailedError, runProcess, type ProcessRunner } from "../../../io";
import { checkGitGate, MAX_LISTED_CHANGES } from "./gitGate";

const ROOT = "/work/orders";

type FakeResponse = { output?: string; exitCode?: number } | { spawnError: string };

/**
 * A runner that answers git by subcommand (the first argument after `-C <root>`
 * and any leading global options), recording each call.
 */
function fakeGit(responses: Record<string, FakeResponse>) {
  const calls: string[][] = [];
  const runner: ProcessRunner = async (command, { cwd, onOutput }) => {
    calls.push(command);
    const args = command.slice(3).filter((arg) => !arg.startsWith("--no-optional-locks"));
    const response = responses[args[0]!] ?? { output: "" };
    if ("spawnError" in response) {
      throw new ProcessFailedError(command, cwd, null, response.spawnError);
    }
    if (response.output) onOutput?.(response.output);
    if ((response.exitCode ?? 0) !== 0) {
      throw new ProcessFailedError(command, cwd, response.exitCode!, response.output ?? "");
    }
  };
  return { runner, calls };
}

const cleanRepo = {
  "rev-parse": { output: "true\n" },
  "ls-files": { output: "agentcore/agentcore.json\n" },
  status: { output: "" },
};

async function gateError(runner: ProcessRunner): Promise<unknown> {
  return checkGitGate(runner, ROOT).then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe("checkGitGate", () => {
  test("passes a clean repository with a tracked project spec", async () => {
    const { runner, calls } = fakeGit(cleanRepo);

    expect(await checkGitGate(runner, ROOT)).toEqual({ projectRoot: ROOT });
    expect(calls).toEqual([
      ["git", "-C", ROOT, "rev-parse", "--is-inside-work-tree"],
      ["git", "-C", ROOT, "ls-files", "--error-unmatch", "agentcore/agentcore.json"],
      ["git", "-C", ROOT, "--no-optional-locks", "status", "--porcelain", "--", "."],
    ]);
  });

  test.each([
    ["Node", "Error: spawn git ENOENT"],
    ["Bun", 'Error: Executable not found in $PATH: "git"'],
  ])("reports git missing from PATH when %s can't find git", async (_runtime, spawnError) => {
    const { runner } = fakeGit({ "rev-parse": { spawnError } });

    const error = await gateError(runner);
    expect(error).toBeInstanceOf(InvalidEnvironmentError);
    expect((error as Error).message).toContain("git isn't installed or isn't on PATH");
    expect((error as InvalidEnvironmentError).meta.reason).toBe("git-not-installed");
  });

  test("doesn't call other spawn failures a missing git", async () => {
    const { runner } = fakeGit({ "rev-parse": { spawnError: "Error: spawn git EACCES" } });

    const error = await gateError(runner);
    expect(error).toBeInstanceOf(ProcessFailedError);
    expect((error as Error).message).toContain("EACCES");
  });

  test("rethrows errors that aren't process failures", async () => {
    const runner: ProcessRunner = async () => {
      throw new Error("aborted");
    };

    await expect(checkGitGate(runner, ROOT)).rejects.toThrow("aborted");
  });

  test("asks for git init when the project isn't in a work tree", async () => {
    const { runner } = fakeGit({
      ...cleanRepo,
      "rev-parse": {
        exitCode: 128,
        output: "fatal: not a git repository (or any of the parent directories): .git\n",
      },
    });

    const error = await gateError(runner);
    expect(error).toBeInstanceOf(ProjectStateError);
    expect((error as Error).message).toBe(
      "agentcore migrate requires the project to be in a git repository so you can review " +
        "and undo the changes. Run `git init` and commit your project first.",
    );
    expect((error as ProjectStateError).meta.reason).toBe("not-a-repository");
  });

  test("passes along git's explanation when rev-parse fails for another reason", async () => {
    const { runner } = fakeGit({
      ...cleanRepo,
      "rev-parse": { exitCode: 128, output: "fatal: detected dubious ownership in repository" },
    });

    const error = await gateError(runner);
    expect(error).toBeInstanceOf(ProjectStateError);
    expect((error as Error).message).toContain("Run `git init`");
    expect((error as Error).message).toContain("detected dubious ownership");
  });

  test("treats a rev-parse answer of false (inside .git) as not a work tree", async () => {
    const { runner } = fakeGit({ ...cleanRepo, "rev-parse": { output: "false\n" } });

    const error = await gateError(runner);
    expect(error).toBeInstanceOf(ProjectStateError);
    expect((error as ProjectStateError).meta.reason).toBe("not-a-repository");
  });

  test("asks the user to commit the project when agentcore.json is untracked", async () => {
    const { runner } = fakeGit({
      ...cleanRepo,
      "ls-files": {
        exitCode: 1,
        output: "error: pathspec 'agentcore/agentcore.json' did not match any file(s) known to git",
      },
    });

    const error = await gateError(runner);
    expect(error).toBeInstanceOf(ProjectStateError);
    expect((error as Error).message).toContain("agentcore/agentcore.json isn't committed to git");
    expect((error as Error).message).toContain("Commit your project");
    expect((error as ProjectStateError).meta.reason).toBe("spec-untracked");
  });

  test("lists uncommitted changes when the tree is dirty", async () => {
    const { runner } = fakeGit({
      ...cleanRepo,
      status: { output: " M agentcore/agentcore.json\n?? app/new.py\n" },
    });

    const error = await gateError(runner);
    expect(error).toBeInstanceOf(ProjectStateError);
    expect((error as Error).message).toBe(
      "Commit or stash your changes before migrating, so the migration is the only change " +
        "to review and undo. Uncommitted changes:\n" +
        "   M agentcore/agentcore.json\n" +
        "  ?? app/new.py",
    );
    expect((error as ProjectStateError).meta.reason).toBe("dirty");
  });

  test("truncates a long list of changes", async () => {
    const changed = Array.from({ length: MAX_LISTED_CHANGES + 3 }, (_, i) => `?? file${i}.txt`);
    const { runner } = fakeGit({ ...cleanRepo, status: { output: `${changed.join("\n")}\n` } });

    const message = ((await gateError(runner)) as Error).message;
    expect(message).toContain(`?? file${MAX_LISTED_CHANGES - 1}.txt`);
    expect(message).not.toContain(`?? file${MAX_LISTED_CHANGES}.txt`);
    expect(message).toEndWith("  ...and 3 more");
  });

  test("reports a status failure without calling the tree dirty", async () => {
    const { runner } = fakeGit({
      ...cleanRepo,
      status: { exitCode: 128, output: "fatal: index file corrupt" },
    });

    const error = await gateError(runner);
    expect(error).toBeInstanceOf(ProjectStateError);
    expect((error as Error).message).toContain("index file corrupt");
    expect((error as ProjectStateError).meta.reason).toBe("status-failed");
  });
});

describe("checkGitGate with real git", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(() => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

  async function projectDirectory(): Promise<string> {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "agentcore-migrate-")));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    await mkdir(join(directory, "agentcore"));
    await writeFile(join(directory, "agentcore", "agentcore.json"), "{}\n");
    return directory;
  }

  const git = (root: string, ...args: string[]) =>
    runProcess(
      [
        "git",
        "-c",
        "user.name=AgentCore Test",
        "-c",
        "user.email=test@example.com",
        "-c",
        "commit.gpgsign=false",
        "-C",
        root,
        ...args,
      ],
      { cwd: root },
    );

  test("walks a project from no repository to committed to dirty", async () => {
    const root = await projectDirectory();
    await expect(checkGitGate(runProcess, root)).rejects.toThrow("Run `git init`");

    await git(root, "init", "--quiet");
    await expect(checkGitGate(runProcess, root)).rejects.toThrow("isn't committed to git");

    await git(root, "add", ".");
    await git(root, "commit", "--quiet", "-m", "init");
    expect(await checkGitGate(runProcess, root)).toEqual({ projectRoot: root });

    await writeFile(join(root, "agentcore", "agentcore.json"), '{"name":"changed"}\n');
    await writeFile(join(root, "notes.txt"), "untracked\n");
    const error = await checkGitGate(runProcess, root).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProjectStateError);
    expect((error as Error).message).toContain(" M agentcore/agentcore.json");
    expect((error as Error).message).toContain("?? notes.txt");
  });
});
