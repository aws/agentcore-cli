import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import {
  DeserializationError,
  InputValidationError,
  ProjectStateError,
  ResourceNotFoundError,
} from "../../errors/errors";
import type { AwsDeploymentTarget } from "../../projectSchemas/aws-targets";
import { credentialEnvVarName } from "../../projectSchemas/credential";
import { ProjectSpecSchema } from "../../projectSchemas/project";
import { ENV_LOCAL_RELATIVE_PATH } from "./envLocal";
import { FsProjectManager } from "./manager";
import { resolveRuntimeTemplateShortcut } from "../../handlers/project/shortcuts";
import {
  type AddResourceInput,
  type CreateProjectInput,
  type DeployResult,
  type Project,
  type ProjectEvent,
} from "../../handlers/project/types";
import { createSilentLogger, TestIdentityClient } from "../../testing";
import type { DeployBackendInput, ProjectBackend } from "./backends/types";

const AGENT_PYTHON = resolveRuntimeTemplateShortcut("agent-python");
const AGENT_PYTHON_CONTAINER = resolveRuntimeTemplateShortcut("agent-python", {
  build: "Container",
});
const AGENT_PYTHON_STRANDS = resolveRuntimeTemplateShortcut("agent-python-strands");
const AGENT_TYPESCRIPT_STRANDS = resolveRuntimeTemplateShortcut("agent-typescript-strands");
const A2A_PYTHON_STRANDS = resolveRuntimeTemplateShortcut("a2a-python-strands");
const A2A_PYTHON_STRANDS_CONTAINER = resolveRuntimeTemplateShortcut("a2a-python-strands", {
  build: "Container",
});

const originalCwd = process.cwd();
const tempDirectories: string[] = [];

async function inTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agentcore-manager-"));
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

// A manager whose runner records commands instead of spawning them.
function manager(): { manager: FsProjectManager; commands: { command: string[]; cwd: string }[] } {
  const commands: { command: string[]; cwd: string }[] = [];
  return {
    manager: new FsProjectManager({
      logger: createSilentLogger(),
      identity: new TestIdentityClient(),
      runner: async (command, { cwd }) => {
        commands.push({ command, cwd });
      },
      checkTool: async () => {}, // CI hosts don't have uv installed
    }),
    commands,
  };
}

async function runCreate(
  subject: FsProjectManager,
  input: CreateProjectInput,
): Promise<{ events: ProjectEvent[]; project: Project }> {
  const iterator = subject.create(input);
  const events: ProjectEvent[] = [];

  while (true) {
    const next = await iterator.next();
    if (next.done) {
      return { events, project: next.value };
    }
    events.push(next.value);
  }
}

async function projectManifest(projectRoot: string): Promise<string[]> {
  return (await readdir(projectRoot, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => relative(projectRoot, join(entry.parentPath, entry.name)).replaceAll("\\", "/"))
    .sort();
}

describe("FsProjectManager.create", () => {
  // The progress driver renders a live tail under the running step from `output` events. Before
  // these steps streamed, subprocess chunks went only to the debug log and the tail stayed empty.
  test("streams subprocess output as output events so progress can tail it", async () => {
    await inTempDirectory();
    const subject = new FsProjectManager({
      logger: createSilentLogger(),
      identity: new TestIdentityClient(),
      runner: async (_command, { onOutput }) => {
        onOutput?.("added 320 packages, and audited 341 packages in 6s\n");
        onOutput?.("partial line with no trailing newline");
      },
      checkTool: async () => {},
    });

    const { events } = await runCreate(subject, {
      name: "example",
      scaffoldRuntimeInput: HELLO_WORLD_PYTHON,
      skipInstall: false,
      skipGit: true,
    });

    const lines = events.flatMap((event) => (event.type === "output" ? [event.line] : []));
    expect(lines).toContain("added 320 packages, and audited 341 packages in 6s");
    // The splitter must flush the unterminated trailing chunk when the process exits.
    expect(lines).toContain("partial line with no trailing newline");
    expect(events.some((event) => event.type === "step")).toBe(true);
  });

  test("scaffolds the expected file tree into a fresh directory", async () => {
    const directory = await inTempDirectory();
    await runCreate(manager().manager, {
      name: "example",
      scaffoldRuntimeInput: AGENT_PYTHON,
    });

    const projectRoot = join(directory, "example");
    expect(await projectManifest(projectRoot)).toMatchSnapshot();
  });

  test("snapshots the Strands project manifest and runtime spec", async () => {
    const directory = await inTempDirectory();
    await runCreate(manager().manager, {
      name: "example",
      scaffoldRuntimeInput: AGENT_PYTHON_STRANDS,
    });

    const projectRoot = join(directory, "example");
    const spec = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
    expect({
      manifest: await projectManifest(projectRoot),
      runtimes: spec.runtimes,
      memories: spec.memories,
    }).toMatchSnapshot();
  });

  test("snapshots the Strands TypeScript project manifest and runtime spec", async () => {
    const directory = await inTempDirectory();
    await runCreate(manager().manager, {
      name: "example",
      scaffoldRuntimeInput: AGENT_TYPESCRIPT_STRANDS,
    });

    const projectRoot = join(directory, "example");
    const spec = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
    expect({
      manifest: await projectManifest(projectRoot),
      runtimes: spec.runtimes,
      memories: spec.memories,
    }).toMatchSnapshot();
  });

  test("snapshots the Strands A2A project manifest and runtime spec", async () => {
    const directory = await inTempDirectory();
    await runCreate(manager().manager, {
      name: "example",
      scaffoldRuntimeInput: A2A_PYTHON_STRANDS,
    });

    const projectRoot = join(directory, "example");
    const spec = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
    expect({
      manifest: await projectManifest(projectRoot),
      runtimes: spec.runtimes,
      memories: spec.memories,
    }).toMatchSnapshot();
  });

  test("scaffolds the Strands A2A runtime with the A2A protocol", async () => {
    const directory = await inTempDirectory();
    await runCreate(manager().manager, {
      name: "example",
      scaffoldRuntimeInput: A2A_PYTHON_STRANDS,
    });

    const spec = await Bun.file(join(directory, "example", "agentcore", "agentcore.json")).json();
    expect(spec.runtimes[0]).toMatchObject({
      name: "a2a_python_strands",
      build: "CodeZip",
      protocol: "A2A",
      entrypoint: "main.py",
    });
    expect(spec.memories).toMatchObject([{ name: "a2a_python_strandsMemory" }]);
  });

  test("scaffolds the Strands A2A runtime as a container with --build Container", async () => {
    const directory = await inTempDirectory();
    await runCreate(manager().manager, {
      name: "example",
      scaffoldRuntimeInput: A2A_PYTHON_STRANDS_CONTAINER,
    });

    const appDir = join(directory, "example", "app", "a2a_python_strands");
    expect(await Bun.file(join(appDir, "Dockerfile")).exists()).toBe(true);
    expect(await Bun.file(join(appDir, ".dockerignore")).exists()).toBe(true);

    const spec = await Bun.file(join(directory, "example", "agentcore", "agentcore.json")).json();
    expect(spec.runtimes[0]).toMatchObject({
      build: "Container",
      dockerfile: "Dockerfile",
      protocol: "A2A",
    });
  });

  test("writes a deploy-ready agentcore.json registering the template agent", async () => {
    const directory = await inTempDirectory();
    await runCreate(manager().manager, {
      name: "example",
      scaffoldRuntimeInput: AGENT_PYTHON,
    });

    const configDir = join(directory, "example", "agentcore");
    const spec = await Bun.file(join(configDir, "agentcore.json")).json();
    expect(spec.name).toBe("example");
    expect(spec.runtimes).toEqual([
      {
        name: "agent_python",
        build: "CodeZip",
        entrypoint: "main.py",
        codeLocation: "app/agent_python",
        runtimeVersion: "PYTHON_3_14",
      },
    ]);
    expect(await Bun.file(join(configDir, "aws-targets.json")).json()).toEqual([]);
  });

  test("scaffolds the container template with a Dockerfile and .dockerignore", async () => {
    const directory = await inTempDirectory();
    await runCreate(manager().manager, {
      name: "example",
      scaffoldRuntimeInput: AGENT_PYTHON_CONTAINER,
    });

    const appDir = join(directory, "example", "app", "agent_python");
    // dockerignore.template must render to .dockerignore (the fsTree regex fix).
    expect(await Bun.file(join(appDir, ".dockerignore")).exists()).toBe(true);
    expect(await Bun.file(join(appDir, "dockerignore.template")).exists()).toBe(false);
    expect(await Bun.file(join(appDir, "Dockerfile")).exists()).toBe(true);

    const spec = await Bun.file(join(directory, "example", "agentcore", "agentcore.json")).json();
    expect(spec.runtimes[0]).toMatchObject({ build: "Container", dockerfile: "Dockerfile" });
  });

  test("refuses to overwrite an existing project", async () => {
    await inTempDirectory();
    const input: CreateProjectInput = {
      name: "example",
      scaffoldRuntimeInput: AGENT_PYTHON,
    };

    await runCreate(manager().manager, input);
    await expect(runCreate(manager().manager, input)).rejects.toBeInstanceOf(ProjectStateError);
  });

  test("validates a harness Dockerfile before writing the project tree", async () => {
    const directory = await inTempDirectory();
    const dockerfile = join(directory, "MissingDockerfile");

    await expect(
      runCreate(manager().manager, {
        name: "example",
        skipInstall: true,
        skipGit: true,
        scaffoldHarnessInput: {
          name: "example",
          model: { provider: "bedrock", modelId: "global.anthropic.claude-sonnet-4-6" },
          dockerfile,
        },
      }),
    ).rejects.toThrow(`dockerfile not found: '${dockerfile}'`);

    expect(existsSync(join(directory, "example"))).toBe(false);
  });

  test("runs npm install, uv sync, and git init after scaffolding", async () => {
    const directory = await inTempDirectory();
    const { manager: subject, commands } = manager();
    await runCreate(subject, {
      name: "example",
      scaffoldRuntimeInput: AGENT_PYTHON,
    });

    const projectRoot = join(directory, "example");
    expect(commands).toEqual([
      { command: ["npm", "install"], cwd: join(projectRoot, "agentcore", "cdk") },
      { command: ["uv", "sync"], cwd: join(projectRoot, "app", "agent_python") },
      { command: ["git", "init"], cwd: projectRoot },
    ]);
  });

  test("skipInstall skips npm install and uv sync", async () => {
    const directory = await inTempDirectory();
    const { manager: subject, commands } = manager();
    await runCreate(subject, {
      name: "example",
      scaffoldRuntimeInput: AGENT_PYTHON,
      skipInstall: true,
    });

    expect(commands).toEqual([{ command: ["git", "init"], cwd: join(directory, "example") }]);
  });

  test.each([
    [
      "Python",
      resolveRuntimeTemplateShortcut("agent-python-strands", { build: "Container" }),
      ["uv", "lock"],
      "agent_python_strands",
    ],
    [
      "TypeScript",
      resolveRuntimeTemplateShortcut("agent-typescript-strands", { build: "Container" }),
      ["npm", "install", "--package-lock-only"],
      "agent_typescript_strands",
    ],
  ])(
    "skipInstall still generates the container lockfile for %s",
    async (_label, scaffoldRuntimeInput, lockCommand, runtimeName) => {
      const directory = await inTempDirectory();
      const { manager: subject, commands } = manager();
      await runCreate(subject, {
        name: "example",
        scaffoldRuntimeInput,
        skipInstall: true,
        skipGit: true,
      });

      expect(commands).toEqual([
        { command: lockCommand, cwd: join(directory, "example", "app", runtimeName) },
      ]);
    },
  );

  test("skipGit skips git init", async () => {
    await inTempDirectory();
    const { manager: subject, commands } = manager();
    await runCreate(subject, {
      name: "example",
      scaffoldRuntimeInput: AGENT_PYTHON,
      skipGit: true,
    });

    expect(commands.map(({ command }) => command[0])).toEqual(["npm", "uv"]);
  });

  test("yields each step as a project event", async () => {
    await inTempDirectory();
    const { events, project } = await runCreate(manager().manager, {
      name: "example",
      scaffoldRuntimeInput: AGENT_PYTHON,
    });

    expect(events.flatMap((event) => (event.type === "step" ? [event.message] : []))).toEqual([
      "Creating project tree",
      "Installing CDK dependencies with npm",
      "Syncing Python dependencies with uv",
      "Initializing git repository",
    ]);
    expect(project.name).toBe("example");
    expect(project.rootPath).toContain("example");
    expect(project.spec.runtimes).toHaveLength(1);
  });

  test("a failed step propagates and leaves the scaffolded files in place", async () => {
    const directory = await inTempDirectory();
    const failing = new FsProjectManager({
      logger: createSilentLogger(),
      identity: new TestIdentityClient(),
      runner: async () => {
        throw new Error("npm exploded");
      },
      checkTool: async () => {},
    });

    await expect(
      runCreate(failing, { name: "example", scaffoldRuntimeInput: AGENT_PYTHON }),
    ).rejects.toThrow("npm exploded");
    expect(await Bun.file(join(directory, "example", "agentcore", "agentcore.json")).exists()).toBe(
      true,
    );
  });

  test("refuses to create a project inside an existing project", async () => {
    const directory = await inTempDirectory();
    await runCreate(manager().manager, {
      name: "root",
      scaffoldRuntimeInput: AGENT_PYTHON,
    });

    process.chdir(join(directory, "root"));
    await expect(
      runCreate(manager().manager, {
        name: "child",
        scaffoldRuntimeInput: AGENT_PYTHON,
      }),
    ).rejects.toBeInstanceOf(ProjectStateError);
  });
});

describe("FsProjectManager.build", () => {
  // build() requires the CDK app's node_modules; create() with skipInstall
  // never produces them, so tests stub the directory in.
  async function scaffolded(
    subject: FsProjectManager,
    directory: string,
    withDependencies = true,
  ): Promise<Project> {
    const { project } = await runCreate(subject, {
      name: "example",
      scaffoldRuntimeInput: AGENT_PYTHON,
      skipInstall: true,
      skipGit: true,
    });
    if (withDependencies) {
      await mkdir(join(directory, "example", "agentcore", "cdk", "node_modules"), {
        recursive: true,
      });
    }
    return project;
  }

  async function drain(generator: AsyncGenerator<ProjectEvent, void>): Promise<ProjectEvent[]> {
    const events: ProjectEvent[] = [];
    for await (const event of generator) events.push(event);
    return events;
  }

  test("compiles and synthesizes via the generated cdk script", async () => {
    const directory = await inTempDirectory();
    const { manager: subject, commands } = manager();
    const project = await scaffolded(subject, directory);
    commands.length = 0; // discard create()'s commands

    const events = await drain(subject.build(project));

    expect(commands).toEqual([
      {
        command: [
          "npm",
          "run",
          "cdk",
          "--",
          "synth",
          "--quiet",
          "--output",
          join(directory, "example", "agentcore", "cdk", "cdk.out"),
        ],
        cwd: join(directory, "example", "agentcore", "cdk"),
      },
    ]);
    expect(events).toEqual([{ type: "step", message: "Synthesizing CloudFormation templates" }]);
  });

  test("fails actionably when the CDK dependencies are missing", async () => {
    const directory = await inTempDirectory();
    const { manager: subject, commands } = manager();
    const project = await scaffolded(subject, directory, false);
    commands.length = 0;

    await expect(drain(subject.build(project))).rejects.toThrow(/npm install/);
    expect(commands).toEqual([]);
  });

  test("refuses a project managed by a backend it cannot build", async () => {
    const directory = await inTempDirectory();
    const { manager: subject, commands } = manager();
    const project = await scaffolded(subject, directory);
    commands.length = 0;

    // CDK is the only backend today; the cast stands in for a future one.
    const foreign = {
      ...project,
      spec: { ...project.spec, managedBy: "Terraform" as Project["spec"]["managedBy"] },
    };
    await expect(drain(subject.build(foreign))).rejects.toThrow(/unsupported backend: Terraform/);
    expect(commands).toEqual([]);
  });

  test("propagates a synthesis failure", async () => {
    const directory = await inTempDirectory();
    const { manager: subject } = manager();
    const project = await scaffolded(subject, directory);
    const failing = new FsProjectManager({
      logger: createSilentLogger(),
      identity: new TestIdentityClient(),
      runner: async () => {
        throw new Error("cdk synth exploded");
      },
      checkTool: async () => {},
    });

    await expect(drain(failing.build(project))).rejects.toThrow("cdk synth exploded");
  });
});

describe("FsProjectManager.deploy", () => {
  type DeployCall = { project: Project; input: DeployBackendInput };

  const STS_ACCOUNT = "999900001111";

  function deployManager(options?: { account?: string | Error }) {
    const calls: DeployCall[] = [];
    const accountCalls: string[] = [];
    const backend: ProjectBackend = {
      async *build() {},
      async *deploy(project, input) {
        calls.push({ project, input });
        yield { type: "step" as const, message: "Backend deployment started" };
        return { outputs: { RuntimeArn: "arn:runtime" } };
      },
      async resolveDeployedResources() {
        return [];
      },
    };
    return {
      calls,
      accountCalls,
      manager: new FsProjectManager({
        logger: createSilentLogger(),
        identity: new TestIdentityClient(),
        backends: { CDK: backend },
        resolveAccount: async (region) => {
          accountCalls.push(region);
          const outcome = options?.account ?? STS_ACCOUNT;
          if (outcome instanceof Error) throw outcome;
          return outcome;
        },
      }),
    };
  }

  async function projectWithTargets(rootPath: string, targets?: unknown): Promise<Project> {
    await mkdir(join(rootPath, "agentcore"), { recursive: true });
    if (targets !== undefined) {
      await writeFile(
        join(rootPath, "agentcore", "aws-targets.json"),
        typeof targets === "string" ? targets : JSON.stringify(targets),
      );
    }
    return {
      name: "example",
      rootPath,
      spec: {
        ...ProjectSpecSchema.parse({ name: "example", version: 1 }),
      },
    };
  }

  async function deploy(
    manager: FsProjectManager,
    project: Project,
    target: string,
    options: { region?: string } = {},
  ): Promise<{ events: ProjectEvent[]; result: DeployResult }> {
    const generator = manager.deploy(project, {
      target,
      region: options.region ?? "us-east-1",
      confirmTeardown: async () => false,
    });
    const events: ProjectEvent[] = [];
    while (true) {
      const next = await generator.next();
      if (next.done) return { events, result: next.value };
      events.push(next.value as ProjectEvent);
    }
  }

  const targets: AwsDeploymentTarget[] = [
    {
      name: "staging",
      account: "111122223333",
      region: "us-east-1",
    },
    {
      name: "prod",
      account: "444455556666",
      region: "eu-west-1",
    },
  ];

  test("resolves one target and returns the backend result", async () => {
    const root = await inTempDirectory();
    const subject = deployManager();
    const project = await projectWithTargets(root, targets);

    const deployed = await deploy(subject.manager, project, "prod");

    expect(subject.calls).toHaveLength(1);
    expect(subject.calls[0]?.project).toBe(project);
    expect(subject.calls[0]?.input.target).toEqual(targets[1]);
    expect(deployed.events).toEqual([{ type: "step", message: "Backend deployment started" }]);
    expect(deployed.result).toEqual({
      outputs: { RuntimeArn: "arn:runtime" },
    });
  });

  test("rejects an unknown target before invoking the backend", async () => {
    const root = await inTempDirectory();
    const subject = deployManager();
    const project = await projectWithTargets(root, targets);

    await expect(deploy(subject.manager, project, "prd")).rejects.toThrow(
      /no deployment target named 'prd'.*staging, prod/s,
    );
    expect(subject.calls).toEqual([]);
  });

  test.each([
    ["a missing file", undefined],
    ["an empty list", []],
  ])(
    "rejects %s before invoking the backend when a named target is requested",
    async (_label, configured) => {
      const root = await inTempDirectory();
      const subject = deployManager();
      const project = await projectWithTargets(root, configured);

      await expect(deploy(subject.manager, project, "staging")).rejects.toThrow(
        /No deployment targets are configured/,
      );
      expect(subject.calls).toEqual([]);
      expect(subject.accountCalls).toEqual([]);
    },
  );

  test.each([
    ["malformed JSON", "{ not-json"],
    ["an invalid target", [{ name: "default", account: "not-an-account", region: "us-east-1" }]],
    [
      "duplicate targets",
      [
        {
          name: "default",
          account: "111122223333",
          region: "us-east-1",
        },
        {
          name: "default",
          account: "444455556666",
          region: "eu-west-1",
        },
      ],
    ],
  ])("rejects %s before invoking the backend", async (_label, configured) => {
    const root = await inTempDirectory();
    const subject = deployManager();
    const project = await projectWithTargets(root, configured);

    await expect(deploy(subject.manager, project, "default")).rejects.toBeInstanceOf(
      DeserializationError,
    );
    expect(subject.calls).toEqual([]);
  });

  const targetsFile = (root: string) => join(root, "agentcore", "aws-targets.json");
  const SYNTHESIZED: AwsDeploymentTarget = {
    name: "default",
    account: STS_ACCOUNT,
    region: "us-east-2",
  };
  const CREATED_MESSAGE =
    `Created default deployment target: account ${STS_ACCOUNT}, ` +
    `region us-east-2 (${join("agentcore", "aws-targets.json")})`;

  test.each([
    ["a missing file", undefined],
    ["an empty list", []],
  ])("synthesizes the default target from %s", async (_label, configured) => {
    const root = await inTempDirectory();
    const subject = deployManager();
    const project = await projectWithTargets(root, configured);

    const deployed = await deploy(subject.manager, project, "default", { region: "us-east-2" });

    expect(subject.accountCalls).toEqual(["us-east-2"]);
    expect(subject.calls).toHaveLength(1);
    expect(subject.calls[0]?.input.target).toEqual(SYNTHESIZED);
    expect(deployed.events).toEqual([
      { type: "step", message: CREATED_MESSAGE },
      { type: "step", message: "Backend deployment started" },
    ]);
    expect(await Bun.file(targetsFile(root)).json()).toEqual([SYNTHESIZED]);
  });

  test("appends the default target and preserves other entries byte for byte", async () => {
    const root = await inTempDirectory();
    const subject = deployManager();
    // Non-canonical key order plus a key the schema does not know about, so a
    // rewrite through the schema (which would reorder and strip) is caught.
    const existing =
      `[\n` +
      `  {\n` +
      `    "region": "eu-west-1",\n` +
      `    "name": "prod",\n` +
      `    "account": "444455556666",\n` +
      `    "note": "hand-tuned"\n` +
      `  }\n` +
      `]`;
    const project = await projectWithTargets(root, existing);

    await deploy(subject.manager, project, "default", { region: "us-east-2" });

    expect(subject.calls[0]?.input.target).toEqual(SYNTHESIZED);
    expect(await Bun.file(targetsFile(root)).text()).toBe(
      `[\n` +
        `  {\n` +
        `    "region": "eu-west-1",\n` +
        `    "name": "prod",\n` +
        `    "account": "444455556666",\n` +
        `    "note": "hand-tuned"\n` +
        `  },\n` +
        `  {\n` +
        `    "name": "default",\n` +
        `    "account": "${STS_ACCOUNT}",\n` +
        `    "region": "us-east-2"\n` +
        `  }\n` +
        `]`,
    );
  });

  test("never synthesizes a named target", async () => {
    const root = await inTempDirectory();
    const subject = deployManager();
    const project = await projectWithTargets(root, targets);

    await expect(deploy(subject.manager, project, "gamma")).rejects.toThrow(
      /no deployment target named 'gamma'.*staging, prod/s,
    );
    expect(subject.calls).toEqual([]);
    expect(subject.accountCalls).toEqual([]);
    expect(await Bun.file(targetsFile(root)).json()).toEqual(targets);
  });

  test("rejects an unsupported region without calling STS or writing the file", async () => {
    const root = await inTempDirectory();
    const subject = deployManager();
    const project = await projectWithTargets(root, undefined);

    const attempt = deploy(subject.manager, project, "default", { region: "us-west-1" });

    await expect(attempt).rejects.toThrow(/'us-west-1' is not an AgentCore-supported region/);
    await expect(
      deploy(subject.manager, project, "default", { region: "us-west-1" }),
    ).rejects.toThrow(/Supported regions: .*us-east-1.*Re-run with --region/s);
    expect(subject.calls).toEqual([]);
    expect(subject.accountCalls).toEqual([]);
    expect(await Bun.file(targetsFile(root)).exists()).toBe(false);
  });

  test("reports an actionable error when the account cannot be resolved", async () => {
    const root = await inTempDirectory();
    const subject = deployManager({
      account: new Error("The security token included in the request is expired"),
    });
    const project = await projectWithTargets(root, undefined);

    await expect(
      deploy(subject.manager, project, "default", { region: "us-east-2" }),
    ).rejects.toThrow(
      /the AWS account could not be resolved: The security token included in the request is expired[\s\S]*aws configure/,
    );
    expect(subject.calls).toEqual([]);
    expect(await Bun.file(targetsFile(root)).exists()).toBe(false);
  });

  test("leaves an existing default target alone", async () => {
    const root = await inTempDirectory();
    const subject = deployManager();
    const configured: AwsDeploymentTarget[] = [
      { name: "default", account: "111122223333", region: "us-west-2" },
    ];
    const contents = JSON.stringify(configured, null, 2);
    const project = await projectWithTargets(root, contents);

    // The requested region differs from the entry's; the entry must win.
    const deployed = await deploy(subject.manager, project, "default", { region: "us-east-2" });

    expect(subject.accountCalls).toEqual([]);
    expect(subject.calls[0]?.input.target).toEqual(configured[0]!);
    expect(deployed.events).toEqual([{ type: "step", message: "Backend deployment started" }]);
    expect(await Bun.file(targetsFile(root)).text()).toBe(contents);
  });
});

describe("FsProjectManager.resolve", () => {
  test("round-trips a project it just created", async () => {
    const root = await inTempDirectory();
    const subject = manager().manager;
    await runCreate(subject, {
      name: "example",
      scaffoldRuntimeInput: AGENT_PYTHON,
    });

    // Resolve from a nested path to prove the walk-up to the project root.
    const resolved = await subject.resolve({ filePath: join(root, "example", "app") });

    expect(resolved?.name).toBe("example");
    expect(resolved?.rootPath).toBe(join(root, "example"));
    expect(resolved?.spec.managedBy).toBe("CDK");
    expect(resolved?.spec.runtimes).toHaveLength(1);
  });

  test("returns undefined when no project encloses the path", async () => {
    const root = await inTempDirectory();
    expect(await manager().manager.resolve({ filePath: root })).toBeUndefined();
  });

  test("throws on a malformed agentcore.json", async () => {
    const root = await inTempDirectory();
    await mkdir(join(root, "agentcore"), { recursive: true });
    await writeFile(join(root, "agentcore", "agentcore.json"), "{ not valid json");

    await expect(manager().manager.resolve({ filePath: root })).rejects.toBeInstanceOf(
      DeserializationError,
    );
  });

  test("names the offending field when the spec fails validation", async () => {
    const root = await inTempDirectory();
    await mkdir(join(root, "agentcore"), { recursive: true });
    // Valid JSON, invalid spec: a CodeZip runtime with no runtimeVersion.
    await writeFile(
      join(root, "agentcore", "agentcore.json"),
      JSON.stringify({
        name: "example",
        version: 1,
        runtimes: [
          {
            name: "agent_python",
            build: "CodeZip",
            entrypoint: "main.py",
            codeLocation: "app/agent_python",
          },
        ],
      }),
    );

    await expect(manager().manager.resolve({ filePath: root })).rejects.toThrow(
      "runtimeVersion is required for CodeZip builds",
    );
  });
});

describe("FsProjectManager removal", () => {
  async function runAdd(
    subject: FsProjectManager,
    project: Project,
    input: AddResourceInput,
  ): Promise<Project> {
    const iterator = subject.addResource(project, input);
    while (true) {
      const next = await iterator.next();
      if (next.done) return next.value;
    }
  }

  async function createdProject(): Promise<{ subject: FsProjectManager; project: Project }> {
    await inTempDirectory();
    const subject = manager().manager;
    const { project } = await runCreate(subject, {
      name: "example",
      scaffoldRuntimeInput: AGENT_PYTHON,
    });
    return { subject, project };
  }

  test.each(["harness", "memory", "credential", "config-bundle", "online-eval"] as const)(
    "removeResource throws ResourceNotFoundError for an unknown %s",
    async (resourceType) => {
      const { subject, project } = await createdProject();

      const removal = subject.removeResource(project, { resourceType, name: "ghost" });

      await expect(removal).rejects.toBeInstanceOf(ResourceNotFoundError);
      await expect(removal).rejects.toThrow(
        `no ${resourceType} named 'ghost' exists in this project`,
      );
    },
  );

  test("removing a credential deletes the .env.local keys it reserved", async () => {
    const { subject, project } = await createdProject();
    const envKey = credentialEnvVarName("svc-key");
    const updated = await runAdd(subject, project, {
      resourceType: "credential",
      resourceConfig: { authorizerType: "ApiKeyCredentialProvider", name: "svc-key" },
      envEntries: [{ key: envKey, value: "sekret", comment: "API key for 'svc-key'" }],
    });
    const envPath = join(project.rootPath, ENV_LOCAL_RELATIVE_PATH);
    expect(await Bun.file(envPath).text()).toContain(envKey);

    const result = await subject.removeResource(updated, {
      resourceType: "credential",
      name: "svc-key",
    });

    expect(result.removedEnvKeys).toEqual([envKey]);
    expect(result.project.spec.credentials).toEqual([]);
    expect(await Bun.file(envPath).text()).not.toContain(envKey);
  });

  test("a removal that fails spec validation rolls back the .env.local edit", async () => {
    const { subject, project } = await createdProject();
    // A payment connector references the credential, so removing the
    // credential must be rejected — and the staged env deletion undone.
    let current = await runAdd(subject, project, {
      resourceType: "credential",
      resourceConfig: {
        authorizerType: "PaymentCredentialProvider",
        name: "pay-cred",
        provider: "CoinbaseCDP",
      },
      envEntries: [
        { key: credentialEnvVarName("pay-cred", "_API_KEY_ID"), value: "id", comment: "c" },
        { key: credentialEnvVarName("pay-cred", "_API_KEY_SECRET"), value: "s", comment: "c" },
        { key: credentialEnvVarName("pay-cred", "_WALLET_SECRET"), value: "w", comment: "c" },
      ],
    });
    current = await runAdd(subject, current, {
      resourceType: "payment-manager",
      resourceConfig: { name: "payments" },
    });
    current = await runAdd(subject, current, {
      resourceType: "payment-connector",
      managerName: "payments",
      resourceConfig: { name: "conn", credentialName: "pay-cred" },
    });
    const envPath = join(project.rootPath, ENV_LOCAL_RELATIVE_PATH);
    const before = await Bun.file(envPath).text();
    const specBefore = await Bun.file(join(project.rootPath, "agentcore", "agentcore.json")).text();

    await expect(
      subject.removeResource(current, { resourceType: "credential", name: "pay-cred" }),
    ).rejects.toBeInstanceOf(InputValidationError);

    expect(await Bun.file(envPath).text()).toBe(before);
    expect(await Bun.file(join(project.rootPath, "agentcore", "agentcore.json")).text()).toBe(
      specBefore,
    );
  });

  test("removeAllResources empties every collection and cleans .env.local", async () => {
    const { subject, project } = await createdProject();
    const envKey = credentialEnvVarName("svc-key");
    let current = await runAdd(subject, project, {
      resourceType: "credential",
      resourceConfig: { authorizerType: "ApiKeyCredentialProvider", name: "svc-key" },
      envEntries: [{ key: envKey, value: "sekret", comment: "c" }],
    });
    current = await runAdd(subject, current, {
      resourceType: "memory",
      resourceConfig: { name: "recall", eventExpiryDuration: 30, strategies: [] },
    });
    current = await runAdd(subject, current, {
      resourceType: "payment-manager",
      resourceConfig: { name: "payments" },
    });
    const envPath = join(project.rootPath, ENV_LOCAL_RELATIVE_PATH);

    const result = await subject.removeAllResources(current);

    expect(result.removedEnvKeys).toEqual([envKey]);
    expect(result.project.spec.runtimes).toEqual([]);
    expect(result.project.spec.memories).toEqual([]);
    expect(result.project.spec.credentials).toEqual([]);
    expect(result.project.spec.payments).toBeUndefined();
    expect(result.project.spec.name).toBe("example");
    expect(result.project.spec.managedBy).toBe("CDK");
    expect(await Bun.file(envPath).text()).not.toContain(envKey);

    // The spec on disk matches what was returned.
    const onDisk = await Bun.file(join(project.rootPath, "agentcore", "agentcore.json")).json();
    expect(onDisk.runtimes).toEqual([]);
    expect(onDisk.payments).toBeUndefined();
  });

  test("removeAllResources is idempotent on an already-empty project", async () => {
    const { subject, project } = await createdProject();
    const once = await subject.removeAllResources(project);
    const twice = await subject.removeAllResources(once.project);

    expect(twice.removedEnvKeys).toEqual([]);
    expect(twice.project.spec.runtimes).toEqual([]);
  });
});
