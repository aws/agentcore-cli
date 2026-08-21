import { describe, expect, test } from "bun:test";
import {
  createSilentLogger,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
} from "../../../testing";
import { InputValidationError } from "../../../errors";
import { createRootHandler } from "../../index";

const INSIGHT = "Builtin.Insight.FailureAnalysis";
const ROLE = "arn:aws:iam::123456789012:role/myEvalRole";

async function run(args: string[]) {
  const io = testIO();
  const core = new TestCoreClient();
  const root = createRootHandler(core, {
    io: io.io,
    globalConfigAccessor: new TestGlobalConfigAccessor(),
    logger: createSilentLogger(),
  });
  await root.route([
    "node",
    "agentcore",
    "eval",
    "online-insight",
    ...args,
    "--region",
    "us-west-2",
  ]);
  return { io, core };
}

function lastCreate(core: TestCoreClient) {
  const call = [...core.eval.calls].reverse().find((c) => c.method === "createOnlineInsight");
  return call?.args[0] as Record<string, unknown> | undefined;
}

describe("eval online-insight create", () => {
  test("agent source sets insights + required role", async () => {
    const { core } = await run([
      "create",
      "--name",
      "prodInsights",
      "--execution-role-arn",
      ROLE,
      "--agent",
      "runtime-123",
      "--insight",
      INSIGHT,
      "--sampling-rate",
      "50",
    ]);
    expect(lastCreate(core)).toMatchObject({
      name: "prodInsights",
      agent: "runtime-123",
      insightIds: [INSIGHT],
      evaluationExecutionRoleArn: ROLE,
      samplingRate: 50,
    });
  });

  test("clustering frequencies flow through", async () => {
    const { core } = await run([
      "create",
      "--name",
      "x",
      "--execution-role-arn",
      ROLE,
      "--agent",
      "runtime-123",
      "--insight",
      INSIGHT,
      "--sampling-rate",
      "10",
      "--clustering-frequency",
      "DAILY",
      "WEEKLY",
    ]);
    expect(lastCreate(core)).toMatchObject({
      clusteringConfig: { frequencies: ["DAILY", "WEEKLY"] },
    });
  });

  test("custom data-source source", async () => {
    const { core } = await run([
      "create",
      "--name",
      "x",
      "--execution-role-arn",
      ROLE,
      "--data-source-config",
      '{"cloudWatchLogs":{"logGroupNames":["/aws/foo"],"serviceNames":["svc"]}}',
      "--insight",
      INSIGHT,
      "--sampling-rate",
      "10",
    ]);
    expect(lastCreate(core)).toMatchObject({
      dataSourceConfig: { cloudWatchLogs: { logGroupNames: ["/aws/foo"] } },
      insightIds: [INSIGHT],
    });
  });

  test.each<[string, string[]]>([
    [
      "missing --name",
      ["--execution-role-arn", ROLE, "--agent", "r", "--insight", INSIGHT, "--sampling-rate", "10"],
    ],
    [
      "missing --execution-role-arn",
      ["--name", "x", "--agent", "r", "--insight", INSIGHT, "--sampling-rate", "10"],
    ],
    [
      "missing --sampling-rate",
      ["--name", "x", "--execution-role-arn", ROLE, "--agent", "r", "--insight", INSIGHT],
    ],
    [
      "missing --insight",
      ["--name", "x", "--execution-role-arn", ROLE, "--agent", "r", "--sampling-rate", "10"],
    ],
    [
      "invalid insight id",
      [
        "--name",
        "x",
        "--execution-role-arn",
        ROLE,
        "--agent",
        "r",
        "--insight",
        "nope",
        "--sampling-rate",
        "10",
      ],
    ],
    [
      "both agent and data-source",
      [
        "--name",
        "x",
        "--execution-role-arn",
        ROLE,
        "--agent",
        "r",
        "--data-source-config",
        "{}",
        "--insight",
        INSIGHT,
        "--sampling-rate",
        "10",
      ],
    ],
    [
      "neither agent nor data-source",
      ["--name", "x", "--execution-role-arn", ROLE, "--insight", INSIGHT, "--sampling-rate", "10"],
    ],
  ])("rejects: %s", async (_label, args) => {
    await expect(run(["create", ...args])).rejects.toBeInstanceOf(InputValidationError);
  });
});

describe("eval online-insight read/lifecycle", () => {
  test("get / delete / pause / resume call the dedicated client methods", async () => {
    const g = await run(["get", "--id", "oi-1"]);
    expect(g.core.eval.calls.some((c) => c.method === "getOnlineInsight")).toBe(true);

    const d = await run(["delete", "--id", "oi-1"]);
    expect(d.core.eval.calls.some((c) => c.method === "deleteOnlineInsight")).toBe(true);

    const p = await run(["pause", "--id", "oi-1"]);
    expect(p.core.eval.calls.some((c) => c.method === "setOnlineInsightExecutionStatus")).toBe(
      true,
    );

    const l = await run(["list"]);
    expect(l.core.eval.calls.some((c) => c.method === "listOnlineInsights")).toBe(true);
  });
});
