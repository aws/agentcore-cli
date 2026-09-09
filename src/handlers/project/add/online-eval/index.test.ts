import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createRootHandler } from "../../../index";
import {
  createSilentLogger,
  initProject,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
} from "../../../../testing";
import { DeserializationError, InputValidationError } from "../../../../errors";

const cleanups: Array<() => Promise<void>> = [];
afterEach(() => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

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

describe("project add online-eval", () => {
  test.each<[string, string[], Record<string, unknown>]>([
    [
      "minimal — agent source",
      [
        "--name",
        "x",
        "--agent",
        "agent_python_minimal",
        "--evaluator",
        "Builtin.Correctness",
        "--sampling-rate",
        "50",
      ],
      { agent: "agent_python_minimal", evaluators: ["Builtin.Correctness"], samplingRate: 50 },
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
        "agent_python_minimal",
        "--endpoint",
        "PROD",
        "--evaluator",
        "Builtin.Correctness",
        "--sampling-rate",
        "10",
      ],
      { agent: "agent_python_minimal", endpoint: "PROD" },
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
        "agent_python_minimal",
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
    const { projectRoot, cleanup } = await initProject({
      flags: ["--template", "agent-python-minimal"],
    });
    cleanups.push(cleanup);
    await run(["add", "online-eval", ...flags]);

    const agentcoreJson = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
    const config = agentcoreJson.onlineEvalConfigs.find((c: { name: string }) => c.name === "x");
    expect(config).toMatchObject(expected);
  });

  test("rejects a duplicate online-eval name", async () => {
    const { cleanup } = await initProject({ flags: ["--template", "agent-python-minimal"] });
    cleanups.push(cleanup);
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
    const { projectRoot, cleanup } = await initProject({
      flags: ["--template", "agent-python-minimal"],
    });
    cleanups.push(cleanup);

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
    const { cleanup } = await initProject({ flags: ["--template", "agent-python-minimal"] });
    cleanups.push(cleanup);
    await expect(run(["add", "online-eval", ...flags])).rejects.toBeInstanceOf(
      InputValidationError,
    );
  });
});
