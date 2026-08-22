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
      "arn:aws:bedrock-agentcore:us-east-1:123456789012:online-evaluation-config/oic-1",
    onlineEvaluationConfigId: "oic-1",
    onlineEvaluationConfigName: "prod_failure_insights",
    status: "ACTIVE",
    executionStatus: "ENABLED",
    insights: [{ insightId: "ins-failure" }],
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
      "arn:aws:bedrock-agentcore:us-east-1:123456789012:online-evaluation-config/oic-1",
    onlineEvaluationConfigId: "oic-1",
    onlineEvaluationConfigName: "prod_failure_insights",
    status: "ACTIVE",
    executionStatus: "ENABLED",
    rule: { samplingConfig: { samplingPercentage: 5 } },
    dataSourceConfig: {
      cloudWatchLogs: { logGroupNames: ["/aws/bedrock-agentcore/runtime/x"], serviceNames: [] },
    },
    insights: [{ insightId: "ins-failure" }, { insightId: "ins-intent" }],
    clusteringConfig: { frequencies: ["DAILY", "WEEKLY"] },
    evaluationExecutionRoleArn: "arn:aws:iam::123456789012:role/online-insight-role",
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

describe("online-insight menu", () => {
  test("offers only the read-only commands", async () => {
    const screen = renderScreen("/agentcore/eval/online-insight");

    await waitForText(screen.lastFrame, "get an online insight config by id");
    const frame = screen.lastFrame()!;
    expect(frame).toContain("list");
    expect(frame).not.toContain("create");
    expect(frame).not.toContain("update");
    expect(frame).not.toContain("pause");
    expect(frame).not.toContain("resume");
    expect(frame).not.toContain("delete");
  });
});

describe("online-insight picker", () => {
  test("renders name, execution status, the insights column, and update time", async () => {
    const core = coreWithConfigs([
      configSummary({
        onlineEvaluationConfigName: "staging_intent_insights",
        executionStatus: "DISABLED",
        updatedAt: new Date("2026-07-21T02:03:04.000Z"),
      }),
    ]);
    const screen = renderScreen("/agentcore/eval/online-insight/list", { core });

    await waitForText(screen.lastFrame, "staging_intent_insights");
    const frame = screen.lastFrame()!;
    expect(frame).toContain("insights");
    expect(frame).toContain("DISABLED");
    expect(frame).toContain("yes");
    expect(frame).toContain("2026-07-21 02:03");
  });

  test("shows '-' in the insights column when a config has no insights", async () => {
    const core = coreWithConfigs([
      configSummary({ onlineEvaluationConfigName: "no_insights_config", insights: [] }),
    ]);
    const screen = renderScreen("/agentcore/eval/online-insight/list", { core });

    await waitForText(screen.lastFrame, "no_insights_config");
    expect(screen.lastFrame()).not.toContain("yes");
  });

  test("calls listOnlineInsights with exact Core options", async () => {
    const core = coreWithConfigs([configSummary()]);
    renderScreen("/agentcore/eval/online-insight/list", { core, endpointUrl: evalEndpointUrl });

    await waitFor(() => core.eval.calls.some((call) => call.method === "listOnlineInsights"));
    expect(core.eval.calls.filter((call) => call.method === "listOnlineInsights")).toEqual([
      {
        method: "listOnlineInsights",
        args: [
          undefined,
          expect.any(Number),
          { region: "us-east-1", endpointUrl: evalEndpointUrl },
        ],
      },
    ]);
  });

  test("bare online-insight get redirects to the picker", async () => {
    const core = coreWithConfigs([
      configSummary({
        onlineEvaluationConfigId: "redirected-oic",
        onlineEvaluationConfigName: "redirected_insight",
      }),
    ]);
    const screen = renderScreen("/agentcore/eval/online-insight/get", { core });

    await waitForText(screen.lastFrame, "redirected_insight");
    expect(core.eval.calls[0]?.method).toBe("listOnlineInsights");
  });

  test("selection opens the matching config detail", async () => {
    const core = coreWithConfigs([configSummary({ onlineEvaluationConfigId: "oic-1" })]);
    core.eval.setOnlineEvalGetResponse(getConfigResponse({ onlineEvaluationConfigId: "oic-1" }));
    const screen = renderScreen("/agentcore/eval/online-insight/list", { core });

    await waitForText(screen.lastFrame, "prod_failure_insights");
    await screen.press("return");
    await waitForText(screen.lastFrame, "agentcore → eval → online-insight → get → oic-1");
    await waitFor(() =>
      core.eval.calls.some(
        (call) => call.method === "getOnlineInsight" && call.args[0] === "oic-1",
      ),
    );
  });

  test("shows the empty state", async () => {
    const empty = renderScreen("/agentcore/eval/online-insight/list");
    await waitForText(empty.lastFrame, "No online insight configs found in this Region.");
  });
});

describe("online-insight detail", () => {
  test("renders sampling, execution status, insight count, and clustering frequencies", async () => {
    const core = new TestCoreClient();
    core.eval.setOnlineEvalGetResponse(getConfigResponse());
    const screen = renderScreen("/agentcore/eval/online-insight/get/oic-1", {
      core,
      endpointUrl: evalEndpointUrl,
    });

    await waitForText(screen.lastFrame, "show the full JSON");
    const frame = screen.lastFrame()!;
    expect(frame).toContain("prod_failure_insights");
    expect(frame).toMatch(/sampling\s+5%/);
    expect(frame).toMatch(/execution\s+ENABLED/);
    expect(frame).toMatch(/insights\s+2/);
    expect(frame).toContain("DAILY, WEEKLY");
    expect(frame).not.toContain("evaluators");
    expect(core.eval.calls.find((call) => call.method === "getOnlineInsight")).toEqual({
      method: "getOnlineInsight",
      args: ["oic-1", { region: "us-east-1", endpointUrl: evalEndpointUrl }],
    });
  });

  test("opens the complete config JSON", async () => {
    const core = new TestCoreClient();
    core.eval.setOnlineEvalGetResponse(getConfigResponse());
    const screen = renderScreen("/agentcore/eval/online-insight/get/oic-1", { core });

    await waitForText(screen.lastFrame, "show the full JSON");
    await screen.press("return");
    await waitForText(screen.lastFrame, "agentcore → eval → online-insight → get → oic-1 → json");
    expect(screen.lastFrame()).toContain('"clusteringConfig"');
  });

  test("retries a failed detail query", async () => {
    const core = new TestCoreClient();
    core.eval.setError(new Error("insight unavailable"));
    const screen = renderScreen("/agentcore/eval/online-insight/get/oic-1", { core });

    await waitForText(screen.lastFrame, "insight unavailable");
    expect(screen.lastFrame()).toContain("[r] retry");

    core.eval.setError(undefined);
    core.eval.setOnlineEvalGetResponse(getConfigResponse());
    await screen.write("r");
    await waitForText(screen.lastFrame, "show the full JSON");
  });
});
