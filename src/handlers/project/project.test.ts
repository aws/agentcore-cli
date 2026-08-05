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

describe.each(["add", "remove", "dev", "deploy", "status"])("project %s", (command) => {
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
    await run(["create", "--project-name", "MyAgent"]);

    // One existence check proves the handler→manager pipe; the full manifest
    // is covered by the FsProjectManager snapshot test.
    const projectRoot = join(directory, "MyAgent");
    expect(await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).exists()).toBe(true);
  });

  test("rejects an invalid --project-name", async () => {
    await inTempDirectory();
    await expect(run(["create", "--project-name", "1-bad"])).rejects.toThrow();
  });

  test("rejects a reserved --project-name", async () => {
    await inTempDirectory();
    await expect(run(["create", "--project-name", "test"])).rejects.toThrow(/conflicts with/);
  });

  test("runs the post-scaffold steps and reports progress on stderr", async () => {
    const directory = await inTempDirectory();
    const { io, core } = await run(["create", "--project-name", "MyAgent"]);

    const projectRoot = join(directory, "MyAgent");
    expect(core.projectCommands).toEqual([
      { command: ["npm", "install"], cwd: join(projectRoot, "agentcore", "cdk") },
      { command: ["uv", "sync"], cwd: join(projectRoot, "app", "hello-world") },
      { command: ["git", "init"], cwd: projectRoot },
    ]);
    expect(io.stderr()).toContain("Scaffolding project files...");
    expect(io.stderr()).toContain("Created project 'MyAgent' in ./MyAgent");
  });

  test("--skip-install and --skip-git run no commands", async () => {
    await inTempDirectory();
    const { core } = await run([
      "create",
      "--project-name",
      "MyAgent",
      "--skip-install",
      "--skip-git",
    ]);

    expect(core.projectCommands).toEqual([]);
  });

  test("rejects an unknown --template value", async () => {
    await inTempDirectory();
    await expect(
      run(["create", "--project-name", "MyAgent", "--template", "nonsense"]),
    ).rejects.toThrow();
  });
});

describe("project build", () => {
  test("builds from a nested directory and emits JSON plus progress", async () => {
    const directory = await inTempDirectory();
    await run(["create", "--project-name", "MyAgent", "--skip-install", "--skip-git"]);
    const projectRoot = join(directory, "MyAgent");
    await Bun.write(
      join(projectRoot, "agentcore", "aws-targets.json"),
      JSON.stringify([
        {
          name: "default",
          account: "123456789012",
          region: "us-east-1",
        },
      ]),
    );
    process.chdir(join(projectRoot, "app", "hello-world"));

    const { io, core } = await run(["build"]);
    const result = JSON.parse(io.stdout());

    expect(result).toMatchObject({
      projectName: "MyAgent",
      backend: "CDK",
      cloudAssemblyPath: "agentcore/cdk/cdk.out",
      manifestPath: "agentcore/.build/manifest.json",
    });
    expect(core.projectCommands).toEqual([
      {
        command: ["npm", "run", "build"],
        cwd: join(projectRoot, "agentcore", "cdk"),
      },
      {
        command: [
          "node",
          join("node_modules", "aws-cdk", "bin", "cdk"),
          "synth",
          "--output",
          "cdk.out",
          "--quiet",
        ],
        cwd: join(projectRoot, "agentcore", "cdk"),
      },
    ]);
    expect(io.stderr()).toContain("Compiling CDK application...");
    expect(io.stderr()).toContain("Recording build manifest...");
  });
});
