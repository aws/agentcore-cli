import { afterEach, describe, expect, test } from "bun:test";
import type {
  GetOnlineEvaluationConfigResponse,
  OnlineEvaluationConfigSummary,
} from "@aws-sdk/client-bedrock-agentcore-control";
import {
  cleanupScreens,
  renderScreen,
  TestCoreClient,
  waitFor,
  waitForText,
} from "../../../testing";

afterEach(cleanupScreens);

const evalEndpointUrl = "https://eval.test";

function configSummary(
  overrides: Partial<OnlineEvaluationConfigSummary> = {},
): OnlineEvaluationConfigSummary {
  return {
    onlineEvaluationConfigArn:
      "arn:aws:bedrock-agentcore:us-east-1:123456789012:online-evaluation-config/oec-1",
    onlineEvaluationConfigId: "oec-1",
    onlineEvaluationConfigName: "prod_quality_watch",
    status: "ACTIVE",
    executionStatus: "ENABLED",
    createdAt: new Date("2026-07-19T01:02:03.000Z"),
    updatedAt: new Date("2026-07-20T12:34:56.000Z"),
    ...overrides,
  };
}

function getConfigResponse(
  overrides: Partial<GetOnlineEvaluationConfigResponse> = {},
): GetOnlineEvaluationConfigResponse {
  return {
    onlineEvaluationConfigArn:
      "arn:aws:bedrock-agentcore:us-east-1:123456789012:online-evaluation-config/oec-1",
    onlineEvaluationConfigId: "oec-1",
    onlineEvaluationConfigName: "prod_quality_watch",
    status: "ACTIVE",
    executionStatus: "ENABLED",
    rule: { samplingConfig: { samplingPercentage: 5 } },
    dataSourceConfig: {
      cloudWatchLogs: { logGroupNames: ["/aws/bedrock-agentcore/runtime/x"], serviceNames: [] },
    },
    evaluators: [{ evaluatorId: "ev-1" }],
    evaluationExecutionRoleArn: "arn:aws:iam::123456789012:role/online-eval-role",
    createdAt: new Date("2026-07-19T01:02:03.000Z"),
    updatedAt: new Date("2026-07-20T12:34:56.000Z"),
    ...overrides,
  };
}

function coreWithConfigs(configs: OnlineEvaluationConfigSummary[]): TestCoreClient {
  const core = new TestCoreClient();
  core.eval.setOnlineEvalListResponse({ onlineEvaluationConfigs: configs });
  return core;
}

describe("online-eval menu", () => {
  test("offers only the read-only commands", async () => {
    const screen = renderScreen("/agentcore/eval/online-eval");

    await waitForText(screen.lastFrame, "get an online evaluation config by id");
    const frame = screen.lastFrame()!;
    expect(frame).toContain("list");
    expect(frame).not.toContain("create");
    expect(frame).not.toContain("update");
    expect(frame).not.toContain("pause");
    expect(frame).not.toContain("resume");
    expect(frame).not.toContain("delete");
  });
});

describe("online-eval picker", () => {
  test("renders name, status, execution status, and update time", async () => {
    const core = coreWithConfigs([
      configSummary({
        onlineEvaluationConfigName: "staging_regression",
        executionStatus: "DISABLED",
        updatedAt: new Date("2026-07-21T02:03:04.000Z"),
      }),
    ]);
    const screen = renderScreen("/agentcore/eval/online-eval/list", { core });

    await waitForText(screen.lastFrame, "staging_regression");
    const frame = screen.lastFrame()!;
    expect(frame).toContain("DISABLED");
    expect(frame).toContain("2026-07-21 02:03");
  });

  test("shows the #2029 insights column: 'yes' when enabled, '-' when not", async () => {
    const core = coreWithConfigs([
      configSummary({
        onlineEvaluationConfigName: "with_insights",
        insights: [{ insightId: "ins-1" }],
      }),
    ]);
    const screen = renderScreen("/agentcore/eval/online-eval/list", { core });

    await waitForText(screen.lastFrame, "with_insights");
    expect(screen.lastFrame()).toContain("insights");
    expect(screen.lastFrame()).toContain("yes");

    const noInsights = renderScreen("/agentcore/eval/online-eval/list", {
      core: coreWithConfigs([configSummary({ onlineEvaluationConfigName: "no_insights" })]),
    });
    await waitForText(noInsights.lastFrame, "no_insights");
    expect(noInsights.lastFrame()).not.toContain("yes");
  });

  test("calls listOnlineEvaluationConfigs with exact Core options", async () => {
    const core = coreWithConfigs([configSummary()]);
    renderScreen("/agentcore/eval/online-eval/list", { core, endpointUrl: evalEndpointUrl });

    await waitFor(() =>
      core.eval.calls.some((call) => call.method === "listOnlineEvaluationConfigs"),
    );
    expect(core.eval.calls.filter((call) => call.method === "listOnlineEvaluationConfigs")).toEqual(
      [
        {
          method: "listOnlineEvaluationConfigs",
          args: [
            undefined,
            expect.any(Number),
            { region: "us-east-1", endpointUrl: evalEndpointUrl },
          ],
        },
      ],
    );
  });

  test("bare online-eval get redirects to the picker", async () => {
    const core = coreWithConfigs([
      configSummary({
        onlineEvaluationConfigId: "redirected-oec",
        onlineEvaluationConfigName: "redirected_config",
      }),
    ]);
    const screen = renderScreen("/agentcore/eval/online-eval/get", { core });

    await waitForText(screen.lastFrame, "redirected_config");
    expect(core.eval.calls[0]?.method).toBe("listOnlineEvaluationConfigs");
  });

  test("selection opens the matching config detail", async () => {
    const core = coreWithConfigs([configSummary({ onlineEvaluationConfigId: "oec-1" })]);
    core.eval.setOnlineEvalGetResponse(getConfigResponse({ onlineEvaluationConfigId: "oec-1" }));
    const screen = renderScreen("/agentcore/eval/online-eval/list", { core });

    await waitForText(screen.lastFrame, "prod_quality_watch");
    await screen.press("return");
    await waitForText(screen.lastFrame, "agentcore → eval → online-eval → get → oec-1");
    await waitFor(() =>
      core.eval.calls.some(
        (call) => call.method === "getOnlineEvaluationConfig" && call.args[0] === "oec-1",
      ),
    );
  });

  test("shows the empty state", async () => {
    const empty = renderScreen("/agentcore/eval/online-eval/list");
    await waitForText(empty.lastFrame, "No online evaluation configs found in this Region.");
  });
});

describe("online-eval detail", () => {
  test("renders sampling, execution status, and evaluator count", async () => {
    const core = new TestCoreClient();
    core.eval.setOnlineEvalGetResponse(getConfigResponse());
    const screen = renderScreen("/agentcore/eval/online-eval/get/oec-1", {
      core,
      endpointUrl: evalEndpointUrl,
    });

    await waitForText(screen.lastFrame, "show the full JSON");
    const frame = screen.lastFrame()!;
    expect(frame).toContain("prod_quality_watch");
    expect(frame).toMatch(/sampling\s+5%/);
    expect(frame).toMatch(/execution\s+ENABLED/);
    expect(frame).toMatch(/evaluators\s+1/);
    expect(core.eval.calls.find((call) => call.method === "getOnlineEvaluationConfig")).toEqual({
      method: "getOnlineEvaluationConfig",
      args: ["oec-1", { region: "us-east-1", endpointUrl: evalEndpointUrl }],
    });
  });

  test("opens the complete config JSON", async () => {
    const core = new TestCoreClient();
    core.eval.setOnlineEvalGetResponse(getConfigResponse());
    const screen = renderScreen("/agentcore/eval/online-eval/get/oec-1", { core });

    await waitForText(screen.lastFrame, "show the full JSON");
    await screen.press("return");
    await waitForText(screen.lastFrame, "agentcore → eval → online-eval → get → oec-1 → json");
    expect(screen.lastFrame()).toContain('"samplingConfig"');
  });

  test("retries a failed detail query", async () => {
    const core = new TestCoreClient();
    core.eval.setError(new Error("config unavailable"));
    const screen = renderScreen("/agentcore/eval/online-eval/get/oec-1", { core });

    await waitForText(screen.lastFrame, "config unavailable");
    expect(screen.lastFrame()).toContain("[r] retry");

    core.eval.setError(undefined);
    core.eval.setOnlineEvalGetResponse(getConfigResponse());
    await screen.write("r");
    await waitForText(screen.lastFrame, "show the full JSON");
  });
});
