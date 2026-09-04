import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRootHandler } from "../../index";
import {
  createSilentLogger,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
  type TestIOOptions,
} from "../../../testing";
import {
  InputValidationError,
  ResourceNotFoundError,
  UserCancellationError,
} from "../../../errors";
import { projectSpec, writeProjectSpec } from "../add/gateway-test-support";
import { credentialEnvVarName } from "../../../projectSchemas/credential";
import { ENV_LOCAL_RELATIVE_PATH } from "../../../core/project/envLocal";

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

async function run(args: string[], ioOptions?: TestIOOptions) {
  const io = testIO(ioOptions);
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
  await run([
    "create",
    "--name",
    name,
    "--template",
    "agent-python-minimal",
    "--skip-install",
    "--skip-git",
  ]);
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
      commands: [["remove", "runtime", "--name", "agent_python_minimal"]],
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
      label: "gateway",
      commands: [
        ["add", "gateway", "--name", "keep"],
        ["add", "gateway", "--name", "remove"],
        ["remove", "gateway", "--name", "remove"],
      ],
      specKey: "agentCoreGateways",
      expectedRemaining: ["keep"],
    },
    {
      label: "config-bundle",
      commands: [
        [
          "add",
          "config-bundle",
          "--name",
          "OrdersConfig",
          "--components",
          '{"arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/orders-agent":{"configuration":{"temperature":0.2}}}',
        ],
        ["remove", "config-bundle", "--name", "OrdersConfig"],
      ],
      specKey: "configBundles",
      expectedRemaining: [],
    },
    {
      label: "online-eval",
      commands: [
        [
          "add",
          "online-eval",
          "--name",
          "quality",
          "--agent",
          "agent_python_minimal",
          "--evaluator",
          "Builtin.Correctness",
          "--sampling-rate",
          "5",
        ],
        ["remove", "online-eval", "--name", "quality"],
      ],
      specKey: "onlineEvalConfigs",
      expectedRemaining: [],
    },
    {
      label: "online-insight",
      commands: [
        [
          "add",
          "online-insight",
          "--name",
          "failures",
          "--agent",
          "agent_python_minimal",
          "--insight",
          "Builtin.Insight.FailureAnalysis",
          "--sampling-rate",
          "5",
        ],
        ["remove", "online-insight", "--name", "failures"],
      ],
      specKey: "onlineEvalConfigs",
      expectedRemaining: [],
    },
    {
      label: "memory",
      commands: [
        ["add", "memory", "--name", "recall"],
        ["remove", "memory", "--name", "recall"],
      ],
      specKey: "memories",
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

  test("removing a non-existent resource fails with a not-found error", async () => {
    const projectRoot = await inProject();
    const before = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).text();

    const removal = run(["remove", "harness", "--name", "ghost"]);
    await expect(removal).rejects.toBeInstanceOf(ResourceNotFoundError);
    await expect(removal).rejects.toThrow(`no harness named 'ghost' exists in this project`);

    // The spec file is untouched, unlike the old warn-and-rewrite behavior.
    expect(await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).text()).toBe(before);
  });

  test("removing a target of a non-existent gateway names the missing gateway", async () => {
    await inProject();
    await expect(
      run(["remove", "gateway-target", "--gateway", "ghost", "--name", "t"]),
    ).rejects.toThrow(`no gateway named 'ghost' exists in this project`);
  });

  test("removing a credential deletes its .env.local entry and reports it", async () => {
    const projectRoot = await inProject();
    await run(["add", "credentials", "api-key", "--name", "svc-key", "--api-key", "-"], {
      stdin: "sekret",
    });
    const envPath = join(projectRoot, ENV_LOCAL_RELATIVE_PATH);
    const envKey = credentialEnvVarName("svc-key");
    expect(await Bun.file(envPath).text()).toContain(`${envKey}='sekret'`);

    const { io } = await run(["remove", "credential", "--name", "svc-key"]);

    expect((await projectSpec(projectRoot)).credentials).toEqual([]);
    expect(await Bun.file(envPath).text()).not.toContain(envKey);
    expect(io.stderr()).toContain(`removed '${envKey}' from ${ENV_LOCAL_RELATIVE_PATH}`);
    expect(io.stderr()).toContain("removed credential with name 'svc-key' from project");
  });

  test("--json reports a removal and its cleaned environment keys", async () => {
    const projectRoot = await inProject();
    await run(["add", "credentials", "api-key", "--name", "svc-key", "--api-key", "-"], {
      stdin: "sekret",
    });
    const envKey = credentialEnvVarName("svc-key");

    const { io } = await run(["remove", "credential", "--name", "svc-key", "--json"]);

    expect(JSON.parse(io.stdout())).toEqual({
      operation: "remove",
      project: { name: "TestProject", path: projectRoot },
      resource: { type: "credential", name: "svc-key" },
      removedEnvironmentKeys: [envKey],
    });
    expect(io.stdout()).not.toContain("removed credential with name");
    expect(io.stderr()).toContain(`removed '${envKey}' from ${ENV_LOCAL_RELATIVE_PATH}`);
  });

  test("removing a secret-reference credential leaves .env.local alone", async () => {
    const projectRoot = await inProject();
    await run([
      "add",
      "credentials",
      "api-key",
      "--name",
      "ext-key",
      "--api-key-secret-reference",
      '{"secretId":"arn:aws:secretsmanager:us-east-1:123456789012:secret:x","jsonKey":"k"}',
    ]);
    const envPath = join(projectRoot, ENV_LOCAL_RELATIVE_PATH);
    await Bun.write(envPath, "USER_MANAGED=1\n");

    const { io } = await run(["remove", "credential", "--name", "ext-key"]);

    expect((await projectSpec(projectRoot)).credentials).toEqual([]);
    expect(await Bun.file(envPath).text()).toBe("USER_MANAGED=1\n");
    expect(io.stderr()).not.toContain("removed '");
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

  test("removes a payment manager with its connectors while preserving reusable credentials", async () => {
    const projectRoot = await inProject();
    await run(["add", "credentials", "payment", "--name", "shared", "--provider", "CoinbaseCDP"]);
    await run(["add", "payment-manager", "--name", "keep"]);
    await run(["add", "payment-manager", "--name", "remove"]);
    await run([
      "add",
      "payment-connector",
      "--manager",
      "remove",
      "--name",
      "connector",
      "--credential",
      "shared",
    ]);

    await run(["remove", "payment-manager", "--name", "remove"]);

    const agentcoreJson = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
    expect(agentcoreJson.payments.map((manager: { name: string }) => manager.name)).toEqual([
      "keep",
    ]);
    expect(agentcoreJson.credentials).toEqual([
      {
        authorizerType: "PaymentCredentialProvider",
        name: "shared",
        provider: "CoinbaseCDP",
      },
    ]);
  });

  test("removes a nested payment connector while preserving siblings and credentials", async () => {
    const projectRoot = await inProject();
    await run(["add", "credentials", "payment", "--name", "shared", "--provider", "CoinbaseCDP"]);
    await run(["add", "payment-manager", "--name", "payments"]);
    await run([
      "add",
      "payment-connector",
      "--manager",
      "payments",
      "--name",
      "keep",
      "--credential",
      "shared",
    ]);
    await run([
      "add",
      "payment-connector",
      "--manager",
      "payments",
      "--name",
      "remove",
      "--credential",
      "shared",
    ]);

    await run(["remove", "payment-connector", "--manager", "payments", "--name", "remove"]);

    const agentcoreJson = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
    expect(
      agentcoreJson.payments[0].connectors.map((connector: { name: string }) => connector.name),
    ).toEqual(["keep"]);
    expect(agentcoreJson.credentials).toEqual([
      {
        authorizerType: "PaymentCredentialProvider",
        name: "shared",
        provider: "CoinbaseCDP",
      },
    ]);
  });

  // Verifies that missing required inputs are rejected before calling the manager.
  test.each<[string, string[]]>([
    ["missing resource argument", ["remove", "--name", "x"]],
    ["missing --name flag", ["remove", "harness"]],
    ["missing --gateway for a Target", ["remove", "gateway-target", "--name", "target"]],
    [
      "missing --manager for a payment connector",
      ["remove", "payment-connector", "--name", "connector"],
    ],
    [
      "--gateway on a non-Target resource",
      ["remove", "gateway", "--gateway", "tools", "--name", "tools"],
    ],
    [
      "--engine on a non-policy resource",
      ["remove", "gateway", "--engine", "Guardrails", "--name", "tools"],
    ],
    [
      "--manager on a non-payment-connector resource",
      ["remove", "payment-manager", "--manager", "payments", "--name", "payments"],
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
    await writeProjectSpec(projectRoot, spec);

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

describe("project remove all", () => {
  // Fills a project with one of everything the CLI can add, plus an
  // unassignedTargets entry only reachable by editing the spec.
  async function populatedProject(): Promise<string> {
    const projectRoot = await inProject();
    await run(["add", "harness", "--name", "my_harness"]);
    await run(["add", "gateway", "--name", "tools"]);
    await run([
      "add",
      "gateway-target",
      "--gateway",
      "tools",
      "--name",
      "search",
      "--endpoint",
      "https://search.example.com",
    ]);
    await run(["add", "credentials", "api-key", "--name", "svc-key", "--api-key", "-"], {
      stdin: "sekret",
    });
    await run(["add", "memory", "--name", "recall"]);
    await run(["add", "policy-engine", "--name", "Guardrails"]);
    await run([
      "add",
      "policy",
      "--engine",
      "Guardrails",
      "--name",
      "DenyAll",
      "--statement",
      "forbid (principal, action, resource);",
    ]);
    await run(["add", "payment-manager", "--name", "payments"]);
    await run([
      "add",
      "config-bundle",
      "--name",
      "OrdersConfig",
      "--components",
      '{"arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/orders-agent":{"configuration":{"temperature":0.2}}}',
    ]);
    const spec = await projectSpec(projectRoot);
    spec.unassignedTargets = [structuredClone(spec.agentCoreGateways[0].targets[0])];
    spec.unassignedTargets[0].name = "orphan";
    await writeProjectSpec(projectRoot, spec);
    return projectRoot;
  }

  test("--yes empties every resource collection while keeping non-resource fields", async () => {
    const projectRoot = await populatedProject();
    const before = await projectSpec(projectRoot);
    const envPath = join(projectRoot, ENV_LOCAL_RELATIVE_PATH);
    const envKey = credentialEnvVarName("svc-key");

    const { io } = await run(["remove", "all", "--yes"]);

    const spec = await projectSpec(projectRoot);
    for (const collection of [
      "runtimes",
      "memories",
      "knowledgeBases",
      "credentials",
      "evaluators",
      "onlineEvalConfigs",
      "agentCoreGateways",
      "policyEngines",
      "configBundles",
      "abTests",
      "harnesses",
    ]) {
      expect(spec[collection]).toEqual([]);
    }
    for (const collection of [
      "mcpRuntimeTools",
      "unassignedTargets",
      "datasets",
      "httpGateways",
      "payments",
    ]) {
      expect(spec[collection]).toBeUndefined();
    }
    expect(spec.name).toBe(before.name);
    expect(spec.version).toBe(before.version);
    expect(spec.managedBy).toBe(before.managedBy);

    // Removal stays spec-level: scaffolded code and the credential's env entry.
    expect(existsSync(join(projectRoot, "app", "agent_python_minimal"))).toBe(true);
    expect(await Bun.file(envPath).text()).not.toContain(envKey);
    expect(io.stderr()).toContain(`removed '${envKey}' from ${ENV_LOCAL_RELATIVE_PATH}`);
    expect(io.stderr()).toContain("removed all resources from project");
    expect(io.stdout()).toBe("");
  });

  test("reports the removal as JSON under --json", async () => {
    await populatedProject();

    const { io } = await run(["remove", "all", "--yes", "--json"]);

    expect(JSON.parse(io.stdout())).toEqual({ message: "removed all resources from project" });
  });

  test("prompts on a TTY and proceeds on 'y'", async () => {
    const projectRoot = await inProject();

    const { io } = await run(["remove", "all"], { isTTY: true, stdin: "y\n" });

    expect(io.stderr()).toContain("Remove every resource from project 'TestProject'?");
    expect((await projectSpec(projectRoot)).runtimes).toEqual([]);
  });

  test("declining the prompt cancels without touching the spec", async () => {
    const projectRoot = await inProject();
    const before = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).text();

    await expect(run(["remove", "all"], { isTTY: true, stdin: "n\n" })).rejects.toBeInstanceOf(
      UserCancellationError,
    );

    expect(await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).text()).toBe(before);
  });

  test("without --yes and without a TTY it fails rather than proceeding", async () => {
    const projectRoot = await inProject();
    const before = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).text();

    const removal = run(["remove", "all"]);
    await expect(removal).rejects.toBeInstanceOf(InputValidationError);
    await expect(removal).rejects.toThrow(/--yes/);

    expect(await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).text()).toBe(before);
  });

  test("rejects --name alongside all", async () => {
    await inProject();
    await expect(run(["remove", "all", "--name", "x", "--yes"])).rejects.toThrow(
      "--name is not valid when removing all resources",
    );
  });

  test("is idempotent on an already-empty project", async () => {
    const projectRoot = await inProject();
    await run(["remove", "all", "--yes"]);
    await run(["remove", "all", "--yes"]);

    expect((await projectSpec(projectRoot)).runtimes).toEqual([]);
  });
});
