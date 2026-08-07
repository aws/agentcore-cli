import { afterEach, test, expect, describe } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRootHandler } from "../index";
import {
  createSilentLogger,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
} from "../../testing";

async function run(args: string[], configure?: (core: TestCoreClient) => void) {
  const io = testIO();
  const core = new TestCoreClient();
  configure?.(core);
  const root = createRootHandler(core, {
    io: io.io,
    globalConfigAccessor: new TestGlobalConfigAccessor(),
    logger: createSilentLogger(),
  });
  await root.route(["node", "agentcore", "project", ...args]);
  return { io, core };
}

describe.each(["add", "remove", "dev", "status"])("project %s", (command) => {
  test("throws because it is not implemented yet", async () => {
    await expect(run([command])).rejects.toThrow(/not implemented/);
  });
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

// Scaffolds a project (skipping installs) and chdirs into it, so build/deploy
// commands resolve it from the working directory like a user would.
async function insideScaffoldedProject(): Promise<string> {
  const directory = await inTempDirectory();
  await run(["create", "--name", "MyAgent", "--skip-install", "--skip-git"]);
  const projectRoot = join(directory, "MyAgent");
  process.chdir(projectRoot);
  return projectRoot;
}

describe("project build", () => {
  test("compiles and synthesizes the vended CDK app, reporting progress on stderr", async () => {
    const projectRoot = await insideScaffoldedProject();
    const { io, core } = await run(["build", "--region", "us-west-2"]);

    const cdkDir = join(projectRoot, "agentcore", "cdk");
    expect(core.projectCommands).toEqual([
      { command: ["npm", "run", "build"], cwd: cdkDir },
      { command: ["npx", "cdk", "synth"], cwd: cdkDir },
    ]);
    expect(io.stderr()).toContain("Compiling the CDK app");
    expect(io.stderr()).toContain("Synthesizing CloudFormation templates with cdk synth");
    // Subprocess output streams through to stderr as it arrives.
    expect(io.stderr()).toContain("ran npx cdk synth");
    expect(io.stderr()).toContain("Build complete");
  });

  test("auto-populates the empty aws-targets.json from the detected account and region", async () => {
    const projectRoot = await insideScaffoldedProject();
    const { io } = await run(["build", "--region", "us-west-2"]);

    expect(io.stderr()).toContain(
      "Configured default deployment target aws://123456789012/us-west-2",
    );
    expect(await Bun.file(join(projectRoot, "agentcore", "aws-targets.json")).json()).toEqual([
      { name: "default", account: "123456789012", region: "us-west-2" },
    ]);
  });

  test("fails actionably when the account cannot be detected", async () => {
    await insideScaffoldedProject();
    await expect(
      run(["build"], (core) => {
        core.projectAccountError = new Error("no credentials");
      }),
    ).rejects.toThrow(/aws-targets\.json/);
  });

  test("fails actionably outside a project", async () => {
    await inTempDirectory();
    await expect(run(["build"])).rejects.toThrow(/No AgentCore project found/);
  });
});

describe("project deploy", () => {
  test("builds, bootstraps, and deploys, reporting progress on stderr", async () => {
    const projectRoot = await insideScaffoldedProject();
    const { io, core } = await run(["deploy", "--region", "us-west-2"]);

    const cdkDir = join(projectRoot, "agentcore", "cdk");
    expect(core.projectCommands).toEqual([
      { command: ["npm", "run", "build"], cwd: cdkDir },
      { command: ["npx", "cdk", "synth"], cwd: cdkDir },
      {
        command: [
          "npx",
          "cdk",
          "bootstrap",
          "aws://123456789012/us-west-2",
          "--bootstrap-customer-key",
        ],
        cwd: cdkDir,
      },
      { command: ["npx", "cdk", "deploy", "--all", "--require-approval", "never"], cwd: cdkDir },
    ]);
    expect(io.stderr()).toContain("Bootstrapping aws://123456789012/us-west-2 with cdk bootstrap");
    expect(io.stderr()).toContain("Deploying stacks with cdk deploy");
    expect(io.stderr()).toContain("Deploy complete");
  });

  test("--skip-bootstrap skips cdk bootstrap", async () => {
    await insideScaffoldedProject();
    const { core } = await run(["deploy", "--region", "us-west-2", "--skip-bootstrap"]);

    expect(core.projectCommands.map(({ command }) => command.join(" "))).toEqual([
      "npm run build",
      "npx cdk synth",
      "npx cdk deploy --all --require-approval never",
    ]);
  });
});
