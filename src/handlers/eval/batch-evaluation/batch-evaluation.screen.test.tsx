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

const evalEndpointUrl = "https://eval.test";

function summary(overrides: Partial<BatchEvaluationSummary> = {}): BatchEvaluationSummary {
  return {
    batchEvaluationArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:batch-evaluate/be-1",
    batchEvaluationId: "be-1",
    batchEvaluationName: "nightly_regression",
    status: "COMPLETED",
    createdAt: new Date("2026-07-19T01:02:03.000Z"),
    updatedAt: new Date("2026-07-20T12:34:56.000Z"),
    ...overrides,
  };
}

function getResponse(
  overrides: Partial<GetBatchEvaluationResponse> = {},
): GetBatchEvaluationResponse {
  return {
    batchEvaluationArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:batch-evaluate/be-1",
    batchEvaluationId: "be-1",
    batchEvaluationName: "nightly_regression",
    status: "COMPLETED",
    createdAt: new Date("2026-07-19T01:02:03.000Z"),
    updatedAt: new Date("2026-07-20T12:34:56.000Z"),
    evaluators: [{ evaluatorId: "Builtin.Correctness" }],
    outputConfig: {
      cloudWatchConfig: {
        logGroupName: "/aws/bedrock-agentcore/evaluations/batch-evaluations/results/default",
        logStreamName: "run-be-1",
      },
    },
    evaluationResults: {
      numberOfSessionsCompleted: 3,
      totalNumberOfSessions: 3,
      numberOfSessionsFailed: 0,
      evaluatorSummaries: [
        {
          evaluatorId: "Builtin.Correctness",
          statistics: { averageScore: 1 },
          totalEvaluated: 3,
          totalFailed: 0,
        },
      ],
    },
    ...overrides,
  };
}

function coreWithBatchEvals(items: BatchEvaluationSummary[]): TestCoreClient {
  const core = new TestCoreClient();
  core.eval.setBatchEvalListResponse({ batchEvaluations: items });
  return core;
}

describe("batch-evaluation menu", () => {
  test("offers get and list", async () => {
    const screen = renderScreen("/agentcore/eval/batch-evaluation");

    await waitForText(screen.lastFrame, "list batch evaluations");
    const frame = screen.lastFrame()!;
    expect(frame).toContain("list");
    expect(frame).toContain("get");
  });
});

describe("batch-evaluation picker", () => {
  test("renders name, status, and updated time", async () => {
    const core = coreWithBatchEvals([
      summary({
        batchEvaluationName: "staging_eval",
        status: "FAILED",
        updatedAt: new Date("2026-07-21T02:03:04.000Z"),
      }),
    ]);
    const screen = renderScreen("/agentcore/eval/batch-evaluation/list", { core });

    await waitForText(screen.lastFrame, "staging_eval");
    const frame = screen.lastFrame()!;
    expect(frame).toContain("FAILED");
    expect(frame).toContain("2026-07-21 02:03");
  });

  test("calls listBatchEvaluations with exact Core options", async () => {
    const core = coreWithBatchEvals([summary()]);
    renderScreen("/agentcore/eval/batch-evaluation/list", { core, endpointUrl: evalEndpointUrl });

    await waitFor(() => core.eval.calls.some((call) => call.method === "listBatchEvaluations"));
    expect(core.eval.calls.filter((call) => call.method === "listBatchEvaluations")).toEqual([
      {
        method: "listBatchEvaluations",
        args: [
          undefined,
          expect.any(Number),
          { region: "us-east-1", endpointUrl: evalEndpointUrl },
        ],
      },
    ]);
  });

  test("bare get redirects to the picker", async () => {
    const core = coreWithBatchEvals([
      summary({ batchEvaluationId: "redirected-be", batchEvaluationName: "redirected_eval" }),
    ]);
    const screen = renderScreen("/agentcore/eval/batch-evaluation/get", { core });

    await waitForText(screen.lastFrame, "redirected_eval");
    expect(core.eval.calls[0]?.method).toBe("listBatchEvaluations");
  });

  test("selection opens the matching batch evaluation JSON", async () => {
    const core = coreWithBatchEvals([summary({ batchEvaluationId: "be-1" })]);
    core.eval.setBatchEvalGetResponse(getResponse({ batchEvaluationId: "be-1" }));
    const screen = renderScreen("/agentcore/eval/batch-evaluation/list", { core });

    await waitForText(screen.lastFrame, "nightly_regression");
    await screen.press("return");
    await waitForText(screen.lastFrame, "agentcore → eval → batch-evaluation → get → be-1");
    await waitFor(() =>
      core.eval.calls.some(
        (call) => call.method === "getBatchEvaluation" && call.args[0] === "be-1",
      ),
    );
  });

  test("shows the empty state", async () => {
    const empty = renderScreen("/agentcore/eval/batch-evaluation/list");
    await waitForText(empty.lastFrame, "No batch evaluations found in this Region.");
  });
});

describe("batch-evaluation detail (raw JSON)", () => {
  test("renders the full response, including merged results", async () => {
    const core = new TestCoreClient();
    core.eval.setBatchEvalGetResponse(getResponse());
    core.eval.setBatchEvalResults([
      { evaluatorId: "Builtin.Correctness", level: "Trace", sessionId: "s1", score: 1 },
    ]);
    const screen = renderScreen("/agentcore/eval/batch-evaluation/get/be-1", {
      core,
      endpointUrl: evalEndpointUrl,
    });

    await waitForText(screen.lastFrame, "nightly_regression");
    const frame = screen.lastFrame()!;
    expect(frame).toContain('"status"');
    expect(frame).toContain("COMPLETED");
    expect(frame).toContain('"evaluationResults"');
    expect(frame).toContain('"results"');
    // Screen requests results by default (no --disable-cw-results in the TUI): it
    // calls getBatchEvaluation(id, opts) with no includeResults override, so the
    // options object defaults to {} (includeResults defaults to true in Core).
    expect(core.eval.calls.find((call) => call.method === "getBatchEvaluation")).toEqual({
      method: "getBatchEvaluation",
      args: ["be-1", { region: "us-east-1", endpointUrl: evalEndpointUrl }, {}],
    });
  });

  test("a CloudWatch results failure still renders the metadata", async () => {
    const core = new TestCoreClient();
    core.eval.setBatchEvalGetResponse(getResponse());
    core.eval.setBatchEvalResultsError(new Error("AccessDenied"));
    const screen = renderScreen("/agentcore/eval/batch-evaluation/get/be-1", { core });

    await waitForText(screen.lastFrame, "nightly_regression");
    const frame = screen.lastFrame()!;
    expect(frame).toContain("COMPLETED"); // status intact
    expect(frame).not.toContain('"results"'); // results omitted, screen didn't crash
  });

  test("retries a failed detail query", async () => {
    const core = new TestCoreClient();
    core.eval.setError(new Error("job unavailable"));
    const screen = renderScreen("/agentcore/eval/batch-evaluation/get/be-1", { core });

    await waitForText(screen.lastFrame, "job unavailable");
    expect(screen.lastFrame()).toContain("[r] retry");

    core.eval.setError(undefined);
    core.eval.setBatchEvalGetResponse(getResponse());
    await screen.write("r");
    await waitForText(screen.lastFrame, "nightly_regression");
  });
});
