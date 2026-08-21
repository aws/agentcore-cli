import { afterEach, test, expect, describe } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRootHandler } from "../index";
import {
  createSilentLogger,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
} from "../../testing";
import { InputValidationError } from "../../errors";

async function run(args: string[], opts?: { core?: TestCoreClient }) {
  const io = testIO();
  const core = opts?.core ?? new TestCoreClient();
  const root = createRootHandler(core, {
    io: io.io,
    globalConfigAccessor: new TestGlobalConfigAccessor(),
    logger: createSilentLogger(),
  });
  await root.route(["node", "agentcore", "project", ...args]);
  return { io, core };
}

describe.each(["deploy", "status"])("project %s", (command) => {
  test("throws because it is not implemented yet", async () => {
    await expect(run([command])).rejects.toThrow(/not implemented/);
  });
});

test("project dev requires an AgentCore project", async () => {
  await inTempDirectory();
  await expect(run(["dev"])).rejects.toThrow(/No AgentCore project found/);
});

const originalCwd = process.cwd();
const tempDirectories: string[] = [];

async function inTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agentcore-project-"));
  tempDirectories.push(directory);
  process.chdir(directory);
  // cwd is the realpath (macOS tmpdir lives behind a /var -> /private/var
  // symlink), matching the paths the manager derives from process.cwd().
  return process.cwd();
}

afterEach(async () => {
  process.chdir(originalCwd);
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** Scaffolds a project and cds into it so withProject resolves it. */
async function inProject(name = "TestProject"): Promise<string> {
  const directory = await inTempDirectory();
  await run(["create", "--name", name, "--skip-install", "--skip-git"]);
  const projectRoot = join(directory, name);
  process.chdir(projectRoot);
  return projectRoot;
}

describe("project create", () => {
  test("scaffolds the project into a fresh directory named for the project", async () => {
    const directory = await inTempDirectory();
    await run(["create", "--name", "MyAgent"]);

    // One existence check proves the handler→manager pipe; the full manifest
    // is covered by the FsProjectManager snapshot test.
    const projectRoot = join(directory, "MyAgent");
    expect(await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).exists()).toBe(true);
  });

  test("rejects an invalid --project-name", async () => {
    await inTempDirectory();
    await expect(run(["create", "--name", "1-bad"])).rejects.toThrow();
  });

  test("rejects a reserved --project-name", async () => {
    await inTempDirectory();
    await expect(run(["create", "--name", "test"])).rejects.toThrow(/conflicts with/);
  });

  test("runs the post-scaffold steps and reports progress on stderr", async () => {
    const directory = await inTempDirectory();
    const { io, core } = await run(["create", "--name", "MyAgent"]);

    const projectRoot = join(directory, "MyAgent");
    expect(core.projectCommands).toEqual([
      { command: ["npm", "install"], cwd: join(projectRoot, "agentcore", "cdk") },
      { command: ["uv", "sync"], cwd: join(projectRoot, "app", "hello-world") },
      { command: ["git", "init"], cwd: projectRoot },
    ]);
    expect(io.stderr()).toContain("Creating project tree");
    expect(io.stderr()).toContain("Installing CDK dependencies with npm");
    expect(io.stderr()).toContain("Syncing Python dependencies with uv");
    expect(io.stderr()).toContain("Initializing git repository");
    expect(io.stderr()).toContain("Created project 'MyAgent' in ./MyAgent");
  });

  test("--skip-install and --skip-git run no commands", async () => {
    await inTempDirectory();
    const { core } = await run(["create", "--name", "MyAgent", "--skip-install", "--skip-git"]);

    expect(core.projectCommands).toEqual([]);
  });

  test("rejects an unknown --template value", async () => {
    await inTempDirectory();
    await expect(run(["create", "--name", "MyAgent", "--template", "nonsense"])).rejects.toThrow();
  });
});

describe("project add config-bundle", () => {
  const components = {
    "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/orders-agent": {
      configuration: {
        systemPrompt: "Help customers with their orders.",
        temperature: 0.2,
      },
    },
  };

  test("adds a configuration bundle to agentcore.json", async () => {
    const projectRoot = await inProject();
    const { io } = await run([
      "add",
      "config-bundle",
      "--name",
      "OrdersConfig",
      "--components",
      JSON.stringify(components),
    ]);

    const spec = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
    expect(spec.configBundles).toEqual([
      {
        name: "OrdersConfig",
        type: "ConfigurationBundle",
        components,
        branchName: "mainline",
      },
    ]);
    expect(io.stderr()).toContain("added configuration bundle 'OrdersConfig' to 'TestProject'");
  });

  test("stores optional configuration bundle fields", async () => {
    const projectRoot = await inProject();
    const kmsKeyArn = "arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012";

    await run([
      "add",
      "config-bundle",
      "--name",
      "OrdersConfig",
      "--description",
      "Configuration for the order support runtime",
      "--components",
      JSON.stringify(components),
      "--branch-name",
      "production",
      "--commit-message",
      "Add the initial order support configuration",
      "--kms-key-arn",
      kmsKeyArn,
    ]);

    const spec = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
    expect(spec.configBundles[0]).toEqual({
      name: "OrdersConfig",
      type: "ConfigurationBundle",
      description: "Configuration for the order support runtime",
      components,
      branchName: "production",
      commitMessage: "Add the initial order support configuration",
      kmsKeyArn,
    });
  });

  test("reads components from a file", async () => {
    const projectRoot = await inProject();
    const componentsPath = join(projectRoot, "components.json");
    await Bun.write(componentsPath, JSON.stringify(components));

    await run([
      "add",
      "config-bundle",
      "--name",
      "OrdersConfig",
      "--components",
      `file://${componentsPath}`,
    ]);

    const spec = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
    expect(spec.configBundles[0].components).toEqual(components);
  });

  test("adds no files under app", async () => {
    const projectRoot = await inProject();

    await run([
      "add",
      "config-bundle",
      "--name",
      "OrdersConfig",
      "--components",
      JSON.stringify(components),
    ]);

    expect(existsSync(join(projectRoot, "app", "OrdersConfig"))).toBe(false);
  });

  test("rejects a duplicate configuration bundle name", async () => {
    await inProject();
    const args = [
      "add",
      "config-bundle",
      "--name",
      "OrdersConfig",
      "--components",
      JSON.stringify(components),
    ];

    await run(args);
    await expect(run(args)).rejects.toBeInstanceOf(InputValidationError);
  });

  test.each([
    ["missing name", ["--components", JSON.stringify(components)]],
    ["missing components", ["--name", "OrdersConfig"]],
    ["invalid name", ["--name", "orders-config", "--components", JSON.stringify(components)]],
    ["empty components", ["--name", "OrdersConfig", "--components", "{}"]],
    [
      "component without configuration",
      ["--name", "OrdersConfig", "--components", '{"arn:component":{}}'],
    ],
    [
      "non-object component configuration",
      [
        "--name",
        "OrdersConfig",
        "--components",
        '{"arn:component":{"configuration":"not-an-object"}}',
      ],
    ],
    [
      "unexpected component field",
      [
        "--name",
        "OrdersConfig",
        "--components",
        '{"arn:component":{"configuration":{},"unexpected":true}}',
      ],
    ],
    ["malformed components", ["--name", "OrdersConfig", "--components", "{not-json"]],
    [
      "empty description",
      ["--name", "OrdersConfig", "--description", "", "--components", JSON.stringify(components)],
    ],
    [
      "branch name above maximum length",
      [
        "--name",
        "OrdersConfig",
        "--components",
        JSON.stringify(components),
        "--branch-name",
        "b".repeat(129),
      ],
    ],
    [
      "commit message above maximum length",
      [
        "--name",
        "OrdersConfig",
        "--components",
        JSON.stringify(components),
        "--commit-message",
        "m".repeat(501),
      ],
    ],
    [
      "invalid KMS key ARN",
      [
        "--name",
        "OrdersConfig",
        "--components",
        JSON.stringify(components),
        "--kms-key-arn",
        "not-an-arn",
      ],
    ],
  ])("rejects %s", async (_label, flags) => {
    await inProject();
    await expect(run(["add", "config-bundle", ...flags])).rejects.toBeInstanceOf(
      InputValidationError,
    );
  });
});

describe("project build", () => {
  async function inBuildableProject(): Promise<string> {
    const projectRoot = await inProject("MyAgent");
    // create --skip-install leaves no node_modules, which build requires.
    await mkdir(join(projectRoot, "agentcore", "cdk", "node_modules"), { recursive: true });
    return projectRoot;
  }

  test("synthesizes the CDK app of the enclosing project", async () => {
    const projectRoot = await inBuildableProject();
    const { io, core } = await run(["build"]);

    expect(core.projectCommands).toEqual([
      {
        command: ["npm", "run", "cdk", "--", "synth", "--quiet"],
        cwd: join(projectRoot, "agentcore", "cdk"),
      },
    ]);
    expect(io.stderr()).toContain("Synthesizing CloudFormation templates");
    expect(io.stderr()).toContain("Built project 'MyAgent'");
  });

  test("resolves the project from a nested directory", async () => {
    const projectRoot = await inBuildableProject();
    process.chdir(join(projectRoot, "app", "hello-world"));

    const { core } = await run(["build"]);

    expect(core.projectCommands.map(({ cwd }) => cwd)).toEqual([
      join(projectRoot, "agentcore", "cdk"),
    ]);
  });

  test("fails with actionable guidance outside a project", async () => {
    await inTempDirectory();
    await expect(run(["build"])).rejects.toThrow(/No AgentCore project found/);
  });

  test("fails when the CDK dependencies have not been installed", async () => {
    const projectRoot = await inBuildableProject();
    await rm(join(projectRoot, "agentcore", "cdk", "node_modules"), { recursive: true });

    await expect(run(["build"])).rejects.toThrow(/npm install/);
  });
});
