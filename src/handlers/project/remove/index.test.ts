import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRootHandler } from "../../index";
import {
  createSilentLogger,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
} from "../../../testing";
import { InputValidationError } from "../../../errors";

const originalCwd = process.cwd();
const tempDirectories: string[] = [];

async function inTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agentcore-remove-"));
  tempDirectories.push(directory);
  process.chdir(directory);
  return process.cwd();
}

afterEach(async () => {
  process.chdir(originalCwd);
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function run(args: string[]) {
  const io = testIO();
  const core = new TestCoreClient();
  const root = createRootHandler(core, {
    io: io.io,
    globalConfigAccessor: new TestGlobalConfigAccessor(),
    logger: createSilentLogger(),
  });
  await root.route(["node", "agentcore", "project", ...args]);
  return { io, core };
}

async function inProject(name = "TestProject"): Promise<string> {
  const directory = await inTempDirectory();
  await run(["create", "--name", name, "--skip-install", "--skip-git"]);
  const projectRoot = join(directory, name);
  process.chdir(projectRoot);
  return projectRoot;
}

type RemoveCase = {
  label: string;
  commands: string[][];
  specKey: string;
  expectedRemaining: string[];
};

describe("project remove", () => {
  // Verifies that resources are removed from agentcore.json and the correct
  // remaining resources are left.
  test.each<RemoveCase>([
    {
      label: "harness",
      commands: [
        ["add", "harness", "--name", "my_harness"],
        ["remove", "harness", "--name", "my_harness"],
      ],
      specKey: "harnesses",
      expectedRemaining: [],
    },
    {
      label: "runtime",
      commands: [["remove", "runtime", "--name", "hello_world"]],
      specKey: "runtimes",
      expectedRemaining: [],
    },
    {
      label: "removes one harness while leaving others intact",
      commands: [
        ["add", "harness", "--name", "keep_me"],
        ["add", "harness", "--name", "remove_me"],
        ["remove", "harness", "--name", "remove_me"],
      ],
      specKey: "harnesses",
      expectedRemaining: ["keep_me"],
    },
    {
      label: "removing a non-existent resource succeeds (no-op)",
      commands: [["remove", "harness", "--name", "ghost"]],
      specKey: "harnesses",
      expectedRemaining: [],
    },
  ])("$label", async ({ commands, specKey, expectedRemaining }) => {
    const projectRoot = await inProject();

    for (const cmd of commands) {
      await run(cmd);
    }

    const agentcoreJson = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
    const remaining = (agentcoreJson[specKey] ?? []) as { name: string }[];
    expect(remaining.map((r) => r.name)).toEqual(expectedRemaining);
  });

  // Verifies that missing required inputs are rejected before calling the manager.
  test.each<[string, string[]]>([
    ["missing resource argument", ["remove", "--name", "x"]],
    ["missing --name flag", ["remove", "harness"]],
  ])("%s", async (_label, args) => {
    await inProject();
    await expect(run(args)).rejects.toBeInstanceOf(InputValidationError);
  });
});
