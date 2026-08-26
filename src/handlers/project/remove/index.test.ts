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
    {
      label: "gateway",
      commands: [
        ["add", "gateway", "--name", "keep"],
        ["add", "gateway", "--name", "remove"],
        ["remove", "gateway", "--name", "remove"],
      ],
      specKey: "agentCoreGateways",
      expectedRemaining: ["keep"],
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

  test.each([
    {
      resource: "gateway-target",
      add: [
        "add",
        "gateway-target",
        "--gateway",
        "tools",
        "--name",
        "remove",
        "--endpoint",
        "https://remove.example.com",
      ],
    },
    {
      resource: "gateway-connector",
      add: [
        "add",
        "gateway-connector",
        "--gateway",
        "tools",
        "--name",
        "remove",
        "--connector",
        "web-search",
      ],
    },
  ])("removes a nested $resource while preserving sibling Targets", async ({ resource, add }) => {
    const projectRoot = await inProject();
    await run(["add", "gateway", "--name", "tools"]);
    await run([
      "add",
      "gateway-target",
      "--gateway",
      "tools",
      "--name",
      "keep",
      "--endpoint",
      "https://keep.example.com",
    ]);
    await run([...add]);

    await run(["remove", resource, "--gateway", "tools", "--name", "remove"]);

    const agentcoreJson = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
    expect(
      agentcoreJson.agentCoreGateways[0].targets.map((target: { name: string }) => target.name),
    ).toEqual(["keep"]);
  });

  // Verifies that missing required inputs are rejected before calling the manager.
  test.each<[string, string[]]>([
    ["missing resource argument", ["remove", "--name", "x"]],
    ["missing --name flag", ["remove", "harness"]],
    ["missing --gateway for a Target", ["remove", "gateway-target", "--name", "target"]],
    [
      "--gateway on a non-Target resource",
      ["remove", "gateway", "--gateway", "tools", "--name", "tools"],
    ],
    [
      "--engine on a non-policy resource",
      ["remove", "gateway", "--engine", "Guardrails", "--name", "tools"],
    ],
  ])("%s", async (_label, args) => {
    await inProject();
    await expect(run(args)).rejects.toBeInstanceOf(InputValidationError);
  });

  async function addPolicy(engine: string, name: string): Promise<void> {
    await run([
      "add",
      "policy",
      "--engine",
      engine,
      "--name",
      name,
      "--statement",
      "forbid (principal, action, resource);",
    ]);
  }

  async function projectSpec(projectRoot: string) {
    return Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
  }

  test.each([
    ["with --engine", ["--engine", "Guardrails"]],
    ["resolving the engine from an unambiguous name", []],
  ])("removes a policy from its engine %s", async (_label, engineArgs) => {
    const projectRoot = await inProject();
    await run(["add", "policy-engine", "--name", "Guardrails"]);
    await addPolicy("Guardrails", "DenyAll");

    await run(["remove", "policy", "--name", "DenyAll", ...engineArgs]);

    expect((await projectSpec(projectRoot)).policyEngines[0].policies).toEqual([]);
  });

  test("rejects an ambiguous policy name without --engine", async () => {
    const projectRoot = await inProject();
    await run(["add", "policy-engine", "--name", "First"]);
    await run(["add", "policy-engine", "--name", "Second"]);
    await addPolicy("First", "DenyAll");
    // Duplicate policy names cannot be added through the CLI, so seed the
    // second one by editing the spec the way a user would.
    const spec = await projectSpec(projectRoot);
    spec.policyEngines[1].policies = spec.policyEngines[0].policies;
    await Bun.write(
      join(projectRoot, "agentcore", "agentcore.json"),
      JSON.stringify(spec, undefined, 2),
    );

    await expect(run(["remove", "policy", "--name", "DenyAll"])).rejects.toThrow(
      "exists in multiple engines: First, Second",
    );
  });

  test("removing an engine strips gateway references", async () => {
    const projectRoot = await inProject();
    await run(["add", "gateway", "--name", "tools"]);
    await run(["add", "policy-engine", "--name", "Guardrails", "--attach-to-gateways", "tools"]);

    await run(["remove", "policy-engine", "--name", "Guardrails"]);

    const spec = await projectSpec(projectRoot);
    expect(spec.policyEngines).toEqual([]);
    expect(spec.agentCoreGateways[0].policyEngineConfiguration).toBeUndefined();
  });
});
