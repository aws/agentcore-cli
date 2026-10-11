import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRootHandler } from "../../index";
import { NotImplementedError, ProjectStateError } from "../../../errors";
import type { ProcessRunner } from "../../../io";
import { Router } from "../../../router";
import { withJsonRenderer } from "../../../middleware";
import {
  createSilentLogger,
  expectError,
  inTempDirectory,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
} from "../../../testing";
import { JsonKey } from "../../keys";
import { createMigrateProjectHandler, MIGRATE_NOT_AVAILABLE_MESSAGE } from "./index";

const cleanups: Array<() => Promise<void>> = [];
afterEach(() => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

/** A temp directory holding only a v0-shaped project marker, which withProject couldn't parse. */
async function inV0Project(): Promise<string> {
  const { path, cleanup } = await inTempDirectory("agentcore-migrate-");
  cleanups.push(cleanup);
  await mkdir(join(path, "agentcore"));
  await writeFile(join(path, "agentcore", "agentcore.json"), '{"version":0,"agents":[]}\n');
  return path;
}

/** Answers git as a clean repository with a tracked spec, recording each call. */
function cleanGit() {
  const calls: string[][] = [];
  const runner: ProcessRunner = async (command, { onOutput }) => {
    calls.push(command);
    if (command.includes("rev-parse")) onOutput?.("true\n");
  };
  return { runner, calls };
}

function migrate(runner: ProcessRunner, args: string[] = []) {
  const io = testIO();
  const app = new Router("agentcore", "test").groupFlags(JsonKey);
  app.use(withJsonRenderer(io.io));
  app.handler(createMigrateProjectHandler({ runner }));
  return { io, run: () => app.route(["node", "agentcore", "migrate", ...args]) };
}

describe("migrate handler", () => {
  test("runs the git gate from the enclosing project root, then reports not available", async () => {
    const root = await inV0Project();
    await mkdir(join(root, "app"));
    process.chdir(join(root, "app"));
    const { runner, calls } = cleanGit();

    await expectError(migrate(runner).run(), MIGRATE_NOT_AVAILABLE_MESSAGE, NotImplementedError);
    expect(calls.map((command) => command.slice(0, 3))).toEqual([
      ["git", "-C", root],
      ["git", "-C", root],
      ["git", "-C", root],
    ]);
  });

  test("stops at the git gate before reporting not available", async () => {
    await inV0Project();
    const runner: ProcessRunner = async (command, { onOutput }) => {
      if (command.includes("rev-parse")) onOutput?.("true\n");
      if (command.includes("status")) onOutput?.(" M agentcore/agentcore.json\n");
    };

    await expectError(migrate(runner).run(), "Commit or stash your changes", ProjectStateError);
  });

  test("uses the shared no-project message without running git", async () => {
    const { path, cleanup } = await inTempDirectory("agentcore-migrate-");
    cleanups.push(cleanup);
    const { runner, calls } = cleanGit();

    await expectError(
      migrate(runner).run(),
      `No AgentCore project found at ${path} or any parent directory`,
      ProjectStateError,
    );
    expect(calls).toEqual([]);
  });

  test("--json writes the error to stdout", async () => {
    await inV0Project();
    const { io, run } = migrate(cleanGit().runner, ["--json"]);

    await expect(run()).rejects.toThrow(NotImplementedError);
    expect(JSON.parse(io.stdout())).toEqual({ error: MIGRATE_NOT_AVAILABLE_MESSAGE });
  });

  test("is registered on the root command", async () => {
    // A temp directory with no project: the real wiring fails before git runs.
    cleanups.push((await inTempDirectory("agentcore-migrate-")).cleanup);
    const root = createRootHandler(new TestCoreClient(), {
      io: testIO().io,
      globalConfigAccessor: new TestGlobalConfigAccessor(),
      logger: createSilentLogger(),
    });

    await expect(root.route(["node", "agentcore", "migrate"])).rejects.toThrow(
      /No AgentCore project found/,
    );
  });
});
