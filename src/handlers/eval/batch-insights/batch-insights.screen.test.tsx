import { afterEach, describe, expect, test } from "bun:test";
import type {
  BatchEvaluationSummary,
  GetBatchEvaluationResponse,
} from "@aws-sdk/client-bedrock-agentcore";
import {
  cleanupScreens,
  renderScreen,
  TestCoreClient,
  waitFor,
  waitForText,
} from "../../../testing";

afterEach(cleanupScreens);

function summary(overrides: Partial<BatchEvaluationSummary> = {}): BatchEvaluationSummary {
  return {
    batchEvaluationArn:
      "arn:aws:bedrock-agentcore:us-east-1:123456789012:batch-evaluate/insights-1",
    batchEvaluationId: "insights-1",
    batchEvaluationName: "failure_analysis",
    status: "COMPLETED",
    createdAt: new Date("2026-08-20T01:02:03.000Z"),
    updatedAt: new Date("2026-08-21T12:34:56.000Z"),
    insights: [{ insightId: "Builtin.Insight.FailureAnalysis" }],
    ...overrides,
  };
}

function detail(overrides: Partial<GetBatchEvaluationResponse> = {}): GetBatchEvaluationResponse {
  return {
    batchEvaluationArn:
      "arn:aws:bedrock-agentcore:us-east-1:123456789012:batch-evaluate/insights-1",
    batchEvaluationId: "insights-1",
    batchEvaluationName: "failure_analysis",
    status: "COMPLETED",
    createdAt: new Date("2026-08-20T01:02:03.000Z"),
    updatedAt: new Date("2026-08-21T12:34:56.000Z"),
    insights: [{ insightId: "Builtin.Insight.FailureAnalysis" }],
    failureAnalysisResult: {
      failures: [],
    },
    ...overrides,
  } as GetBatchEvaluationResponse;
}

function coreWithBatchEvaluations(items: BatchEvaluationSummary[]): TestCoreClient {
  const core = new TestCoreClient();
  core.eval.setBatchEvalListResponse({ batchEvaluations: items });
  return core;
}

describe("batch-insights menu", () => {
  test("offers only read-only commands", async () => {
    const screen = renderScreen("/agentcore/eval/batch-insights");

    await waitForText(screen.lastFrame, "list batch insights runs");
    const frame = screen.lastFrame()!;
    expect(frame).toContain("list");
    expect(frame).toContain("get");
    expect(frame).not.toContain("start an asynchronous batch insights run");
  });
});

describe("batch-insights picker", () => {
  test("filters evaluator-only jobs from the shared service page", async () => {
    const core = coreWithBatchEvaluations([
      summary(),
      summary({
        batchEvaluationId: "evaluation-1",
        batchEvaluationName: "quality_evaluation",
        insights: undefined,
        evaluators: [{ evaluatorId: "Builtin.Correctness" }],
      }),
    ]);
    const screen = renderScreen("/agentcore/eval/batch-insights/list", { core });

    await waitForText(screen.lastFrame, "failure_analysis");
    const frame = screen.lastFrame()!;
    expect(frame).not.toContain("quality_evaluation");
    expect(core.eval.calls[0]?.method).toBe("listBatchEvaluations");
  });

  test("bare get redirects to the filtered picker", async () => {
    const core = coreWithBatchEvaluations([summary()]);
    const screen = renderScreen("/agentcore/eval/batch-insights/get", { core });

    await waitForText(screen.lastFrame, "failure_analysis");
    expect(core.eval.calls[0]?.method).toBe("listBatchEvaluations");
  });

  test("selection opens the matching insights JSON", async () => {
    const core = coreWithBatchEvaluations([summary()]);
    core.eval.setBatchEvalGetResponse(detail());
    const screen = renderScreen("/agentcore/eval/batch-insights/list", { core });

    await waitForText(screen.lastFrame, "failure_analysis");
    await screen.press("return");
    await waitForText(screen.lastFrame, "agentcore → eval → batch-insights → get → insights-1");
    await waitFor(() =>
      core.eval.calls.some(
        (call) => call.method === "getBatchEvaluation" && call.args[0] === "insights-1",
      ),
    );
  });

  test("shows the Insights-specific empty state", async () => {
    const core = coreWithBatchEvaluations([
      summary({
        insights: undefined,
        evaluators: [{ evaluatorId: "Builtin.Correctness" }],
      }),
    ]);
    const screen = renderScreen("/agentcore/eval/batch-insights/list", { core });

    await waitForText(screen.lastFrame, "No batch insights found in this Region.");
  });
});

describe("batch-insights detail", () => {
  test("renders service-side reports without requesting CloudWatch results", async () => {
    const core = new TestCoreClient();
    core.eval.setBatchEvalGetResponse(detail());
    const screen = renderScreen("/agentcore/eval/batch-insights/get/insights-1", { core });

    await waitForText(screen.lastFrame, "failure_analysis");
    const frame = screen.lastFrame()!;
    expect(frame).toContain('"failureAnalysisResult"');
    expect(core.eval.calls.find((call) => call.method === "getBatchEvaluation")).toEqual({
      method: "getBatchEvaluation",
      args: ["insights-1", { region: "us-east-1" }, { includeResults: false }],
    });
  });

  test("rejects direct navigation to an evaluator-only job", async () => {
    const core = new TestCoreClient();
    core.eval.setBatchEvalGetResponse(
      detail({
        batchEvaluationId: "evaluation-1",
        insights: undefined,
        evaluators: [{ evaluatorId: "Builtin.Correctness" }],
        failureAnalysisResult: undefined,
      }),
    );
    const screen = renderScreen("/agentcore/eval/batch-insights/get/evaluation-1", { core });

    await waitForText(screen.lastFrame, "is not a batch insights run");
  });
});
