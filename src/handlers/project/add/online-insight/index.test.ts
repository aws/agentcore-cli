import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRootHandler } from "../../../index";
import {
  createSilentLogger,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
} from "../../../../testing";
import { DeserializationError, InputValidationError } from "../../../../errors";

const originalCwd = process.cwd();
const tempDirectories: string[] = [];

async function inTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agentcore-online-insight-"));
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

async function inProject(name = "TestProject"): Promise<string> {
  const directory = await inTempDirectory();
  await run(["create", "--name", name, "--skip-install", "--skip-git"]);
  const projectRoot = join(directory, name);
  process.chdir(projectRoot);
  return projectRoot;
}

const INSIGHT = "Builtin.Insight.FailureAnalysis";

describe("project add online-insight", () => {
  test.each<[string, string[], Record<string, unknown>]>([
    [
      "minimal — agent source",
      ["--name", "x", "--agent", "hello_world", "--insight", INSIGHT, "--sampling-rate", "50"],
      { agent: "hello_world", insights: [INSIGHT], samplingRate: 50 },
    ],
    [
      "custom log-group source",
      [
        "--name",
        "x",
        "--log-group-name",
        "/aws/foo",
        "--insight",
        INSIGHT,
        "--sampling-rate",
        "50",
      ],
      { logGroupNames: ["/aws/foo"], insights: [INSIGHT], samplingRate: 50 },
    ],
    [
      "agent source with endpoint",
      [
        "--name",
        "x",
        "--agent",
        "hello_world",
        "--endpoint",
        "PROD",
        "--insight",
        INSIGHT,
        "--sampling-rate",
        "10",
      ],
      { agent: "hello_world", endpoint: "PROD" },
    ],
    [
      "clustering frequencies",
      [
        "--name",
        "x",
        "--agent",
        "hello_world",
        "--insight",
        INSIGHT,
        "--sampling-rate",
        "10",
        "--clustering-frequency",
        "DAILY",
        "WEEKLY",
      ],
      { clusteringConfig: { frequencies: ["DAILY", "WEEKLY"] } },
    ],
    [
      "service-name filter on a custom source",
      [
        "--name",
        "x",
        "--log-group-name",
        "/aws/foo",
        "--service-name",
        "svc",
        "--insight",
        INSIGHT,
        "--sampling-rate",
        "25",
      ],
      { logGroupNames: ["/aws/foo"], serviceNames: ["svc"] },
    ],
    [
      "description, enable-on-create false, tags",
      [
        "--name",
        "x",
        "--agent",
        "hello_world",
        "--insight",
        INSIGHT,
        "--sampling-rate",
        "5",
        "--description",
        "monitor prod",
        "--enable-on-create",
        "false",
        "--tags",
        '{"team":"ml"}',
      ],
      { description: "monitor prod", enableOnCreate: false, tags: { team: "ml" } },
    ],
  ])("%s", async (_label, flags, expected) => {
    const projectRoot = await inProject();
    await run(["add", "online-insight", ...flags]);

    const agentcoreJson = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
    const config = agentcoreJson.onlineEvalConfigs.find((c: { name: string }) => c.name === "x");
    expect(config).toMatchObject(expected);
  });

  test("rejects a duplicate online-insight name", async () => {
    await inProject();
    const flags = [
      "--name",
      "x",
      "--agent",
      "hello_world",
      "--insight",
      INSIGHT,
      "--sampling-rate",
      "50",
    ];
    await run(["add", "online-insight", ...flags]);
    await expect(run(["add", "online-insight", ...flags])).rejects.toBeInstanceOf(
      InputValidationError,
    );
  });

  test("rejects when the existing spec is invalid", async () => {
    const projectRoot = await inProject();

    const specPath = join(projectRoot, "agentcore", "agentcore.json");
    const spec = await Bun.file(specPath).json();
    spec.unknownField = "bad";
    await Bun.write(specPath, JSON.stringify(spec));

    await expect(
      run([
        "add",
        "online-insight",
        "--name",
        "x",
        "--agent",
        "hello_world",
        "--insight",
        INSIGHT,
        "--sampling-rate",
        "5",
      ]),
    ).rejects.toBeInstanceOf(DeserializationError);
  });

  test.each<[string, string[]]>([
    ["missing --name", ["--agent", "a", "--insight", INSIGHT, "--sampling-rate", "10"]],
    ["missing --sampling-rate", ["--name", "x", "--agent", "a", "--insight", INSIGHT]],
    ["no --insight", ["--name", "x", "--agent", "a", "--sampling-rate", "10"]],
    [
      "invalid insight id",
      ["--name", "x", "--agent", "a", "--insight", "NotAnInsight", "--sampling-rate", "10"],
    ],
    [
      "--agent and --log-group-name are mutually exclusive",
      [
        "--name",
        "x",
        "--agent",
        "a",
        "--log-group-name",
        "/x",
        "--insight",
        INSIGHT,
        "--sampling-rate",
        "10",
      ],
    ],
    [
      "--endpoint without --agent",
      [
        "--name",
        "x",
        "--log-group-name",
        "/x",
        "--endpoint",
        "PROD",
        "--insight",
        INSIGHT,
        "--sampling-rate",
        "10",
      ],
    ],
    [
      "--service-name without --log-group-name",
      [
        "--name",
        "x",
        "--agent",
        "a",
        "--service-name",
        "svc",
        "--insight",
        INSIGHT,
        "--sampling-rate",
        "10",
      ],
    ],
  ])("%s", async (_label, flags) => {
    await inProject();
    await expect(run(["add", "online-insight", ...flags])).rejects.toBeInstanceOf(
      InputValidationError,
    );
  });
});
