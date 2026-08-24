import { describe, expect, test } from "bun:test";
import type {
  GetBatchEvaluationResponse,
  ListBatchEvaluationsResponse,
} from "@aws-sdk/client-bedrock-agentcore";
import {
  createSilentLogger,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
} from "../../../testing";
import { createRootHandler } from "../../index";

const REGION = "us-west-2";

async function run(args: string[], configure?: (core: TestCoreClient) => void) {
  const core = new TestCoreClient();
  configure?.(core);
  const io = testIO();
  const root = createRootHandler(core, {
    io: io.io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });
  await root.route(["bun", "agentcore", ...args, "--region", REGION]);
  return { core, stdout: io.stdout(), stderr: io.stderr() };
}

describe("eval batch-insights command hierarchy", () => {
  test("registers only run, get, and list", () => {
    const io = testIO();
    const root = createRootHandler(new TestCoreClient(), {
      io: io.io,
      logger: createSilentLogger(),
      globalConfigAccessor: new TestGlobalConfigAccessor(),
    });
    const group = root
      .children()
      .find((child) => child.name() === "eval")
      ?.children()
      .find((child) => child.name() === "batch-insights");

    expect(group?.children().map((child) => child.name())).toEqual(["run", "get", "list"]);
  });

  test("prints help for a bare invocation without a Core call", async () => {
    const { core, stdout } = await run(["eval", "batch-insights", "--json"]);
    expect(stdout).toContain("Usage: agentcore eval batch-insights");
    expect(core.eval.calls).toHaveLength(0);
  });
});

describe("eval batch-insights run", () => {
  test("requires --name and exactly one session source", async () => {
    await expect(run(["eval", "batch-insights", "run", "--agent", "agent-1"])).rejects.toThrow(
      /--name/,
    );
    await expect(run(["eval", "batch-insights", "run", "--name", "insights_run"])).rejects.toThrow(
      /exactly one source/,
    );
    await expect(
      run([
        "eval",
        "batch-insights",
        "run",
        "--name",
        "insights_run",
        "--agent",
        "agent-1",
        "--online-eval",
        "online-1",
      ]),
    ).rejects.toThrow(/exactly one source/);
  });

  test("uses failure analysis by default and passes the resolved agent source", async () => {
    const { core } = await run([
      "eval",
      "batch-insights",
      "run",
      "--name",
      "insights_run",
      "--agent",
      "agent-1",
      "--endpoint",
      "prod",
      "--start-time",
      "2026-08-01T00:00:00Z",
      "--end-time",
      "2026-08-02T00:00:00Z",
      "--session-ids",
      "s1",
      "s2",
      "--description",
      "Analyze failures",
      "--kms-key-arn",
      "arn:aws:kms:us-west-2:123:key/abc",
      "--json",
    ]);

    expect(core.eval.calls).toEqual([
      {
        method: "startBatchInsights",
        args: [
          {
            name: "insights_run",
            description: "Analyze failures",
            insightIds: ["Builtin.Insight.FailureAnalysis"],
            evaluatorIds: undefined,
            source: {
              origin: "agent",
              agent: "agent-1",
              endpoint: "prod",
              window: {
                startTime: new Date("2026-08-01T00:00:00Z"),
                endTime: new Date("2026-08-02T00:00:00Z"),
              },
              sessionIds: ["s1", "s2"],
            },
            kmsKeyArn: "arn:aws:kms:us-west-2:123:key/abc",
          },
          { region: REGION },
        ],
      },
    ]);
  });

  test("accepts explicit insights and optional evaluator chaining", async () => {
    const { core } = await run([
      "eval",
      "batch-insights",
      "run",
      "--name",
      "insights_run",
      "--online-eval",
      "online-1",
      "--insight",
      "Builtin.Insight.UserIntent",
      "Builtin.Insight.ExecutionSummary",
      "--evaluator",
      "Builtin.Helpfulness",
      "--json",
    ]);

    expect(core.eval.calls[0]?.method).toBe("startBatchInsights");
    expect(core.eval.calls[0]?.args[0]).toMatchObject({
      insightIds: ["Builtin.Insight.UserIntent", "Builtin.Insight.ExecutionSummary"],
      evaluatorIds: ["Builtin.Helpfulness"],
      source: {
        origin: "online-eval",
        onlineEvaluationConfigId: "online-1",
      },
    });
  });
});

describe("eval batch-insights get", () => {
  test("returns insight reports without reading CloudWatch scores", async () => {
    const response = {
      batchEvaluationId: "bi-1",
      status: "COMPLETED",
      insights: [{ insightId: "Builtin.Insight.FailureAnalysis" }],
      failureAnalysisResult: { failures: [] },
    } as unknown as GetBatchEvaluationResponse;
    const { core, stdout } = await run(
      ["eval", "batch-insights", "get", "--id", "bi-1", "--json"],
      (client) => client.eval.setBatchEvalGetResponse(response),
    );

    expect(JSON.parse(stdout)).toMatchObject({
      batchEvaluationId: "bi-1",
      failureAnalysisResult: { failures: [] },
    });
    expect(JSON.parse(stdout).consoleUrl).toBeUndefined();
    expect(core.eval.calls[0]?.args[2]).toEqual({ includeResults: false });
  });

  test("rejects an evaluator-only batch evaluation", async () => {
    const response = {
      batchEvaluationId: "be-1",
      evaluators: [{ evaluatorId: "Builtin.Helpfulness" }],
    } as unknown as GetBatchEvaluationResponse;

    await expect(
      run(["eval", "batch-insights", "get", "--id", "be-1"], (client) =>
        client.eval.setBatchEvalGetResponse(response),
      ),
    ).rejects.toThrow(/not a batch insights run/);
  });
});

describe("eval batch-insights list", () => {
  test("filters mixed service results and preserves pagination", async () => {
    const response = {
      batchEvaluations: [
        {
          batchEvaluationId: "bi-1",
          insights: [{ insightId: "Builtin.Insight.FailureAnalysis" }],
        },
        {
          batchEvaluationId: "be-1",
          evaluators: [{ evaluatorId: "Builtin.Helpfulness" }],
        },
        { batchEvaluationId: "bi-2", insights: [{ insightId: "Builtin.Insight.UserIntent" }] },
      ],
      nextToken: "next-page",
    } as unknown as ListBatchEvaluationsResponse;
    const { core, stdout } = await run(
      ["eval", "batch-insights", "list", "--next-token", "page-1", "--max-results", "20", "--json"],
      (client) => client.eval.setBatchEvalListResponse(response, "page-1"),
    );
    const output = JSON.parse(stdout);

    expect(output.nextToken).toBe("next-page");
    expect(
      output.batchEvaluations.map((item: { batchEvaluationId: string }) => item.batchEvaluationId),
    ).toEqual(["bi-1", "bi-2"]);
    expect(output.batchEvaluations[0].consoleUrl).toBeUndefined();
    expect(core.eval.calls[0]?.args).toEqual(["page-1", 20, { region: REGION }]);
  });
});
