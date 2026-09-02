import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRootHandler } from "../../index";
import {
  createSilentLogger,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
} from "../../../testing";

const HARNESS_ARN = "arn:aws:bedrock-agentcore:us-west-2:111122223333:harness/h-abc123";

function testExportCommand() {
  const core = new TestCoreClient();
  // A fresh root per invocation, so wiring-time state (e.g. the add router's
  // pinned cwd) always reflects the directory the test has cd'd into. The core
  // client is shared so mock responses and recorded calls span invocations.
  const route = (args: string[]) => {
    const io = testIO({});
    const root = createRootHandler(core, {
      io: io.io,
      globalConfigAccessor: new TestGlobalConfigAccessor(),
      logger: createSilentLogger(),
    });
    subject.io = io;
    return root.route(["node", "agentcore", ...args]);
  };
  const subject = {
    /** IO captured for the most recent invocation. */
    io: undefined as unknown as ReturnType<typeof testIO>,
    core,
    project: (args: string[]) => route(["project", ...args]),
    run: (args: string[] = []) => route(["project", "export", "harness", ...args]),
  };
  return subject;
}

const originalCwd = process.cwd();
const tempDirectories: string[] = [];

async function inTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agentcore-export-"));
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

/** Scaffolds a project with one harness named `exportme` and cds into it. */
async function inProjectWithHarness(
  subject: ReturnType<typeof testExportCommand>,
): Promise<string> {
  const directory = await inTempDirectory();
  await subject.project([
    "create",
    "--name",
    "orders",
    "--template",
    "agent-python",
    "--skip-install",
    "--skip-git",
  ]);
  const projectRoot = join(directory, "orders");
  process.chdir(projectRoot);
  await subject.project([
    "add",
    "harness",
    "--name",
    "exportme",
    "--model",
    JSON.stringify({ provider: "bedrock", modelId: "us.amazon.nova-lite-v1:0", maxTokens: 256 }),
    "--system-prompt",
    "You are a terse assistant.",
  ]);
  return projectRoot;
}

describe("project export harness handler", () => {
  test("requires exactly one of --name and --arn", async () => {
    const subject = testExportCommand();
    await inProjectWithHarness(subject);

    await expect(subject.run([])).rejects.toThrow(/exactly one of --name .* or --arn/);
    await expect(subject.run(["--name", "exportme", "--arn", HARNESS_ARN])).rejects.toThrow(
      /exactly one of --name .* or --arn/,
    );
  });

  test("exports an in-project harness to a buildable runtime and registers it", async () => {
    const subject = testExportCommand();
    const projectRoot = await inProjectWithHarness(subject);

    await subject.run(["--name", "exportme"]);

    // Generated code reflects the harness spec.
    const agentDir = join(projectRoot, "app", "exportmeAgent");
    expect(await Bun.file(join(agentDir, "main.py")).text()).toContain(
      'DEFAULT_SYSTEM_PROMPT = """You are a terse assistant."""',
    );
    const loadModel = await Bun.file(join(agentDir, "model", "load.py")).text();
    expect(loadModel).toContain('model_id="us.amazon.nova-lite-v1:0"');
    expect(loadModel).toContain("max_tokens=256");
    expect(await Bun.file(join(agentDir, "EXPORT_NOTES.md")).text()).toContain(
      "# Export Notes — exportme → exportmeAgent",
    );

    // agentcore.json gains the runtime; the harness entry stays.
    const spec = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
    expect(spec.runtimes).toContainEqual({
      name: "exportmeAgent",
      build: "CodeZip",
      entrypoint: "main.py",
      codeLocation: "app/exportmeAgent",
      protocol: "HTTP",
      runtimeVersion: "PYTHON_3_14",
    });
    expect(spec.harnesses).toEqual([{ name: "exportme", path: "app/exportme" }]);

    // Dependencies are installed in the new agent dir.
    expect(subject.core.projectCommands).toContainEqual({
      command: ["uv", "sync"],
      cwd: agentDir,
    });

    expect(subject.io.stderr()).toContain(
      "Exported harness 'exportme' to runtime agent 'exportmeAgent'",
    );
    expect(subject.io.stdout()).toBe("");
  });

  test("derives the default target name and honors --target-agent-name", async () => {
    const subject = testExportCommand();
    const projectRoot = await inProjectWithHarness(subject);

    await subject.run(["--name", "exportme", "--target-agent-name", "my_agent"]);

    expect(existsSync(join(projectRoot, "app", "my_agent", "main.py"))).toBe(true);
    await expect(
      subject.run(["--name", "exportme", "--target-agent-name", "9bad"]),
    ).rejects.toThrow(/invalid --target-agent-name/);
  });

  test("refuses to overwrite an existing runtime, harness, or directory", async () => {
    const subject = testExportCommand();
    const projectRoot = await inProjectWithHarness(subject);

    // The scaffolded template runtime already owns its name.
    await expect(
      subject.run(["--name", "exportme", "--target-agent-name", "hello_world"]),
    ).rejects.toThrow(/runtime with name 'hello_world' already exists/);
    // A harness name is just as taken.
    await expect(
      subject.run(["--name", "exportme", "--target-agent-name", "exportme"]),
    ).rejects.toThrow(/harness with name 'exportme' already exists/);

    // A second export of the same harness collides with the first.
    await subject.run(["--name", "exportme"]);
    const specBefore = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).text();
    await expect(subject.run(["--name", "exportme"])).rejects.toThrow(
      /runtime with name 'exportmeAgent' already exists/,
    );
    expect(await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).text()).toBe(
      specBefore,
    );
  });

  test("fails clearly when the harness is not in the project", async () => {
    const subject = testExportCommand();
    await inProjectWithHarness(subject);

    await expect(subject.run(["--name", "nope"])).rejects.toThrow(
      /Harness 'nope' not found .* Available harnesses: exportme/,
    );
  });

  test("emits a machine-readable summary with --json", async () => {
    const subject = testExportCommand();
    const projectRoot = await inProjectWithHarness(subject);

    await subject.run(["--name", "exportme", "--json"]);

    expect(JSON.parse(subject.io.stdout())).toEqual({
      harnessName: "exportme",
      agentName: "exportmeAgent",
      agentPath: join(projectRoot, "app", "exportmeAgent"),
      notesPath: join(projectRoot, "app", "exportmeAgent", "EXPORT_NOTES.md"),
      notes: [],
    });
  });

  test("exports a service harness by ARN, fetching from the ARN's region", async () => {
    const subject = testExportCommand();
    const projectRoot = await inProjectWithHarness(subject);
    subject.core.harness.setGetResponse({
      harness: {
        harnessId: "h-abc123",
        harnessName: "remote_harness",
        arn: HARNESS_ARN,
        status: "READY",
        executionRoleArn: "arn:aws:iam::111122223333:role/HarnessRole",
        createdAt: new Date(0),
        updatedAt: new Date(0),
        model: { bedrockModelConfig: { modelId: "us.amazon.nova-lite-v1:0" } },
        systemPrompt: [{ text: "Fetched prompt." }],
        tools: [],
        skills: [],
      },
    } as never);

    await subject.run(["--arn", HARNESS_ARN, "--target-agent-name", "exported_arn"]);

    expect(subject.core.harness.calls).toEqual([
      {
        method: "getHarness",
        args: ["h-abc123", expect.objectContaining({ region: "us-west-2" })],
      },
    ]);
    expect(await Bun.file(join(projectRoot, "app", "exported_arn", "main.py")).text()).toContain(
      'DEFAULT_SYSTEM_PROMPT = """Fetched prompt."""',
    );
    const spec = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
    expect(spec.runtimes.map((runtime: { name: string }) => runtime.name)).toContain(
      "exported_arn",
    );
  });

  test("defaults the --arn target name from the fetched harness name", async () => {
    const subject = testExportCommand();
    const projectRoot = await inProjectWithHarness(subject);
    subject.core.harness.setGetResponse({
      harness: {
        harnessName: "remote_harness",
        model: { bedrockModelConfig: { modelId: "us.amazon.nova-lite-v1:0" } },
      },
    } as never);

    await subject.run(["--arn", HARNESS_ARN]);

    expect(existsSync(join(projectRoot, "app", "remote_harnessAgent", "main.py"))).toBe(true);
  });

  /** A container harness in VPC mode, whose service VpcConfig carries no vpcId (the API has none). */
  function setVpcContainerHarness(subject: ReturnType<typeof testExportCommand>) {
    subject.core.harness.setGetResponse({
      harness: {
        harnessName: "remote_container",
        model: { bedrockModelConfig: { modelId: "us.amazon.nova-lite-v1:0" } },
        environmentArtifact: {
          containerConfiguration: {
            containerUri: "111122223333.dkr.ecr.us-west-2.amazonaws.com/base:latest",
          },
        },
        environment: {
          agentCoreRuntimeEnvironment: {
            networkConfiguration: {
              networkMode: "VPC",
              networkModeConfig: {
                subnets: ["subnet-0123456789abcdef0"],
                securityGroups: ["sg-0123456789abcdef0"],
              },
            },
          },
        },
      },
    } as never);
  }

  // A container harness in a VPC exports as CodeZip: no image build, so no CodeBuild and no vpcId
  // to supply. The service's subnets and security groups still carry over verbatim.
  test("exports a VPC container harness as CodeZip without additional lookups", async () => {
    const subject = testExportCommand();
    const projectRoot = await inProjectWithHarness(subject);
    setVpcContainerHarness(subject);

    await subject.run(["--arn", HARNESS_ARN]);

    expect(subject.core.harness.calls).toEqual([
      {
        method: "getHarness",
        args: ["h-abc123", expect.objectContaining({ region: "us-west-2" })],
      },
    ]);
    const spec = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
    const runtime = spec.runtimes.find(
      (candidate: { name: string }) => candidate.name === "remote_containerAgent",
    );
    expect(runtime.build).toBe("CodeZip");
    expect(runtime.dockerfile).toBeUndefined();
    expect(runtime.networkConfig).toEqual({
      subnets: ["subnet-0123456789abcdef0"],
      securityGroups: ["sg-0123456789abcdef0"],
    });
    expect(existsSync(join(projectRoot, "app", "remote_containerAgent", "Dockerfile"))).toBe(false);
  });

  test("validates the project before fetching from the service", async () => {
    const subject = testExportCommand();
    await inTempDirectory(); // not a project

    await expect(subject.run(["--arn", HARNESS_ARN])).rejects.toThrow(/No AgentCore project found/);
    expect(subject.core.harness.calls).toEqual([]);
  });

  test("rejects a malformed --arn before calling the service", async () => {
    const subject = testExportCommand();
    await inProjectWithHarness(subject);

    await expect(subject.run(["--arn", "arn:aws:not-a-harness"])).rejects.toThrow(
      /not a valid harness ARN/,
    );
    expect(subject.core.harness.calls).toEqual([]);

    await expect(
      subject.run(["--arn", "arn:aws:lambda:us-west-2:111122223333:harness/h-abc123"]),
    ).rejects.toThrow(/not a valid harness ARN/);
    expect(subject.core.harness.calls).toEqual([]);
  });
});
