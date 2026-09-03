import { afterEach, describe, expect, test } from "bun:test";
import type {
  EvaluatorSummary,
  GetEvaluatorResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import {
  cleanupScreens,
  renderScreen,
  TestCoreClient,
  waitFor,
  waitForText,
  menuEntries,
} from "../../../testing";

afterEach(cleanupScreens);

const evalEndpointUrl = "https://eval.test";

function evaluatorSummary(overrides: Partial<EvaluatorSummary> = {}): EvaluatorSummary {
  return {
    evaluatorArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:evaluator/ev-1",
    evaluatorId: "ev-1",
    evaluatorName: "answer_relevance",
    evaluatorType: "Custom",
    level: "SESSION",
    status: "ACTIVE",
    createdAt: new Date("2026-07-19T01:02:03.000Z"),
    updatedAt: new Date("2026-07-20T12:34:56.000Z"),
    lockedForModification: false,
    ...overrides,
  };
}

function getEvaluatorResponse(overrides: Partial<GetEvaluatorResponse> = {}): GetEvaluatorResponse {
  return {
    evaluatorArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:evaluator/ev-1",
    evaluatorId: "ev-1",
    evaluatorName: "answer_relevance",
    level: "SESSION",
    status: "ACTIVE",
    lockedForModification: false,
    createdAt: new Date("2026-07-19T01:02:03.000Z"),
    updatedAt: new Date("2026-07-20T12:34:56.000Z"),
    evaluatorConfig: {
      llmAsAJudge: {
        instructions: "Rate whether the answer is relevant.",
        ratingScale: {
          numerical: [{ value: 1, label: "Poor", definition: "Fails to meet expectations" }],
        },
        modelConfig: { bedrockEvaluatorModelConfig: { modelId: "anthropic.claude" } },
      },
    },
    ...overrides,
  };
}

function coreWithEvaluators(evaluators: EvaluatorSummary[]): TestCoreClient {
  const core = new TestCoreClient();
  core.eval.setListResponse({ evaluators });
  return core;
}

describe("evaluator menu", () => {
  test("lists the read-only commands, then the rest as command line only", async () => {
    const screen = renderScreen("/agentcore/eval/evaluator");

    await waitForText(screen.lastFrame, "get an evaluator by ID");
    expect(menuEntries(screen.lastFrame()!)).toEqual({
      screens: ["get", "list"],
      cliOnly: ["llm-as-a-judge", "code-based", "delete"],
    });
  });

  test("the eval root menu shows evaluator and online-eval", async () => {
    const screen = renderScreen("/agentcore/eval");

    await waitForText(screen.lastFrame, "manage AgentCore evaluators");
    expect(screen.lastFrame()).toContain("online-eval");
  });
});

describe("evaluator picker", () => {
  test("renders name, type, level, and update time", async () => {
    const core = coreWithEvaluators([
      evaluatorSummary({
        evaluatorName: "Builtin.Correctness",
        evaluatorType: "Builtin",
        level: "TRACE",
        updatedAt: new Date("2026-07-21T02:03:04.000Z"),
      }),
    ]);
    const screen = renderScreen("/agentcore/eval/evaluator/list", { core });

    await waitForText(screen.lastFrame, "Builtin.Correctness");
    const frame = screen.lastFrame()!;
    expect(frame).toContain("Builtin");
    expect(frame).toContain("TRACE");
    expect(frame).toContain("2026-07-21 02:03");
  });

  test("calls listEvaluators with exact Core options", async () => {
    const core = coreWithEvaluators([evaluatorSummary()]);
    renderScreen("/agentcore/eval/evaluator/list", { core, endpointUrl: evalEndpointUrl });

    await waitFor(() => core.eval.calls.some((call) => call.method === "listEvaluators"));
    expect(core.eval.calls.filter((call) => call.method === "listEvaluators")).toEqual([
      {
        method: "listEvaluators",
        args: [
          undefined,
          expect.any(Number),
          { region: "us-east-1", endpointUrl: evalEndpointUrl },
        ],
      },
    ]);
  });

  test("bare evaluator get redirects to the picker", async () => {
    const core = coreWithEvaluators([
      evaluatorSummary({ evaluatorId: "redirected-ev", evaluatorName: "redirected_eval" }),
    ]);
    const screen = renderScreen("/agentcore/eval/evaluator/get", { core });

    await waitForText(screen.lastFrame, "redirected_eval");
    expect(core.eval.calls[0]?.method).toBe("listEvaluators");
  });

  test("selection opens the matching evaluator detail", async () => {
    const core = coreWithEvaluators([evaluatorSummary({ evaluatorId: "ev-1" })]);
    core.eval.setGetResponse(getEvaluatorResponse({ evaluatorId: "ev-1" }));
    const screen = renderScreen("/agentcore/eval/evaluator/list", { core });

    await waitForText(screen.lastFrame, "answer_relevance");
    await screen.press("return");
    await waitForText(screen.lastFrame, "agentcore → eval → evaluator → get → ev-1");
    await waitFor(() =>
      core.eval.calls.some((call) => call.method === "getEvaluator" && call.args[0] === "ev-1"),
    );
  });

  test("shows the empty state", async () => {
    const empty = renderScreen("/agentcore/eval/evaluator/list");
    await waitForText(empty.lastFrame, "No evaluators found in this Region.");
  });
});

describe("evaluator detail", () => {
  test("renders the summary and derives the kind from the config union", async () => {
    const core = new TestCoreClient();
    core.eval.setGetResponse(getEvaluatorResponse());
    const screen = renderScreen("/agentcore/eval/evaluator/get/ev-1", {
      core,
      endpointUrl: evalEndpointUrl,
    });

    await waitForText(screen.lastFrame, "show the full JSON definition");
    const frame = screen.lastFrame()!;
    expect(frame).toContain("answer_relevance");
    expect(frame).toContain("LLM-as-a-Judge");
    expect(frame).toMatch(/level\s+SESSION/);
    expect(core.eval.calls.find((call) => call.method === "getEvaluator")).toEqual({
      method: "getEvaluator",
      args: ["ev-1", { region: "us-east-1", endpointUrl: evalEndpointUrl }],
    });
  });

  test("labels a code-based evaluator", async () => {
    const core = new TestCoreClient();
    core.eval.setGetResponse(
      getEvaluatorResponse({
        evaluatorConfig: {
          codeBased: { lambdaConfig: { lambdaArn: "arn:aws:lambda:us-east-1:1234:function:x" } },
        },
      }),
    );
    const screen = renderScreen("/agentcore/eval/evaluator/get/ev-1", { core });

    await waitForText(screen.lastFrame, "code-based");
  });

  test("shows a locked marker only when locked", async () => {
    const unlocked = new TestCoreClient();
    unlocked.eval.setGetResponse(getEvaluatorResponse({ lockedForModification: false }));
    const open = renderScreen("/agentcore/eval/evaluator/get/ev-1", { core: unlocked });
    await waitForText(open.lastFrame, "show the full JSON definition");
    expect(open.lastFrame()).not.toContain("locked");
    open.unmount();

    const lockedCore = new TestCoreClient();
    lockedCore.eval.setGetResponse(getEvaluatorResponse({ lockedForModification: true }));
    const locked = renderScreen("/agentcore/eval/evaluator/get/ev-1", { core: lockedCore });
    await waitForText(locked.lastFrame, "locked");
  });

  test("opens the complete evaluator JSON", async () => {
    const core = new TestCoreClient();
    core.eval.setGetResponse(getEvaluatorResponse());
    const screen = renderScreen("/agentcore/eval/evaluator/get/ev-1", { core });

    await waitForText(screen.lastFrame, "show the full JSON definition");
    await screen.press("return");
    await waitForText(screen.lastFrame, "agentcore → eval → evaluator → get → ev-1 → json");
    expect(screen.lastFrame()).toContain('"instructions"');
  });

  test("retries a failed detail query", async () => {
    const core = new TestCoreClient();
    core.eval.setError(new Error("evaluator unavailable"));
    const screen = renderScreen("/agentcore/eval/evaluator/get/ev-1", { core });

    await waitForText(screen.lastFrame, "evaluator unavailable");
    expect(screen.lastFrame()).toContain("[r] retry");

    core.eval.setError(undefined);
    core.eval.setGetResponse(getEvaluatorResponse());
    await screen.write("r");
    await waitForText(screen.lastFrame, "show the full JSON definition");
  });
});
