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
  const directory = await mkdtemp(join(tmpdir(), "agentcore-online-eval-"));
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
  await run([
    "create",
    "--name",
    name,
    "--template",
    "hello-world-python",
    "--skip-install",
    "--skip-git",
  ]);
  const projectRoot = join(directory, name);
  process.chdir(projectRoot);
  return projectRoot;
}

describe("project add online-eval", () => {
  test.each<[string, string[], Record<string, unknown>]>([
    [
      "minimal — agent source",
      [
        "--name",
        "x",
        "--agent",
        "hello_world",
        "--evaluator",
        "Builtin.Correctness",
        "--sampling-rate",
        "50",
      ],
      { agent: "hello_world", evaluators: ["Builtin.Correctness"], samplingRate: 50 },
    ],
    [
      "custom log-group source",
      [
        "--name",
        "x",
        "--log-group-name",
        "/aws/foo",
        "--evaluator",
        "Builtin.Correctness",
        "--sampling-rate",
        "50",
      ],
      { logGroupNames: ["/aws/foo"], evaluators: ["Builtin.Correctness"], samplingRate: 50 },
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
        "--evaluator",
        "Builtin.Correctness",
        "--sampling-rate",
        "10",
      ],
      { agent: "hello_world", endpoint: "PROD" },
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
        "--evaluator",
        "Builtin.Correctness",
        "--sampling-rate",
        "25",
      ],
      { logGroupNames: ["/aws/foo"], serviceNames: ["svc"] },
    ],
    [
      "description",
      [
        "--name",
        "x",
        "--log-group-name",
        "/aws/foo",
        "--evaluator",
        "Builtin.Correctness",
        "--sampling-rate",
        "5",
        "--description",
        "monitor prod",
      ],
      { description: "monitor prod" },
    ],
    [
      "enable-on-create false",
      [
        "--name",
        "x",
        "--agent",
        "hello_world",
        "--evaluator",
        "Builtin.Correctness",
        "--sampling-rate",
        "5",
        "--enable-on-create",
        "false",
      ],
      { enableOnCreate: false },
    ],
    [
      "tags",
      [
        "--name",
        "x",
        "--log-group-name",
        "/aws/foo",
        "--evaluator",
        "Builtin.Correctness",
        "--sampling-rate",
        "5",
        "--tags",
        '{"team":"ml"}',
      ],
      { tags: { team: "ml" } },
    ],
  ])("%s", async (_label, flags, expected) => {
    const projectRoot = await inProject();
    await run(["add", "online-eval", ...flags]);

    const agentcoreJson = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
    const config = agentcoreJson.onlineEvalConfigs.find((c: { name: string }) => c.name === "x");
    expect(config).toMatchObject(expected);
  });

  test("rejects a duplicate online-eval name", async () => {
    await inProject();
    const flags = [
      "--name",
      "x",
      "--log-group-name",
      "/aws/foo",
      "--evaluator",
      "Builtin.Correctness",
      "--sampling-rate",
      "50",
    ];
    await run(["add", "online-eval", ...flags]);
    await expect(run(["add", "online-eval", ...flags])).rejects.toBeInstanceOf(
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
        "online-eval",
        "--name",
        "x",
        "--agent",
        "a",
        "--evaluator",
        "e",
        "--sampling-rate",
        "5",
      ]),
    ).rejects.toBeInstanceOf(DeserializationError);
  });

  test.each<[string, string[]]>([
    ["missing --name", ["--log-group-name", "/x", "--evaluator", "e", "--sampling-rate", "10"]],
    ["missing --sampling-rate", ["--name", "x", "--log-group-name", "/x", "--evaluator", "e"]],
    [
      "--agent and --log-group-name are mutually exclusive",
      [
        "--name",
        "x",
        "--agent",
        "a",
        "--log-group-name",
        "/x",
        "--evaluator",
        "e",
        "--sampling-rate",
        "10",
      ],
    ],
    [
      "neither --agent nor --log-group-name",
      ["--name", "x", "--evaluator", "e", "--sampling-rate", "10"],
    ],
    ["no evaluator", ["--name", "x", "--agent", "a", "--sampling-rate", "10"]],
    [
      "--endpoint without --agent",
      [
        "--name",
        "x",
        "--log-group-name",
        "/x",
        "--endpoint",
        "PROD",
        "--evaluator",
        "e",
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
        "--evaluator",
        "e",
        "--sampling-rate",
        "10",
      ],
    ],
  ])("%s", async (_label, flags) => {
    await inProject();
    await expect(run(["add", "online-eval", ...flags])).rejects.toBeInstanceOf(
      InputValidationError,
    );
  });
});
