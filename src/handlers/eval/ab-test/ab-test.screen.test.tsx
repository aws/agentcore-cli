import { afterEach, describe, expect, test } from "bun:test";
import type { GetABTestResponse, ABTestSummary } from "@aws-sdk/client-bedrock-agentcore";
import {
  cleanupScreens,
  renderScreen,
  TestCoreClient,
  waitFor,
  waitForText,
} from "../../../testing";

afterEach(cleanupScreens);

function summary(overrides: Partial<ABTestSummary> = {}): ABTestSummary {
  return {
    abTestId: "ab-test-1",
    abTestArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:ab-test/ab-test-1",
    name: "orders-v2",
    status: "ACTIVE",
    executionStatus: "RUNNING",
    gatewayArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:gateway/orders",
    updatedAt: new Date("2026-07-20T12:34:56.000Z"),
    createdAt: new Date("2026-07-19T01:02:03.000Z"),
    ...overrides,
  };
}

function getResponse(overrides: Partial<GetABTestResponse> = {}): GetABTestResponse {
  return {
    abTestId: "ab-test-1",
    abTestArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:ab-test/ab-test-1",
    name: "orders-v2",
    status: "ACTIVE",
    executionStatus: "RUNNING",
    gatewayArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:gateway/orders",
    variants: [
      { name: "C", weight: 50 },
      { name: "T1", weight: 50 },
    ],
    results: {
      evaluatorMetrics: [
        {
          evaluatorArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:evaluator/quality",
          controlStats: { treatmentName: "C", sampleSize: 100, mean: 0.8 },
          variantResults: [
            { treatmentName: "T1", sampleSize: 100, mean: 0.86, isSignificant: true },
          ],
        },
      ],
    },
    ...overrides,
  } as GetABTestResponse;
}

function coreWithTests(tests: ABTestSummary[]): TestCoreClient {
  const core = new TestCoreClient();
  core.eval.setAbTestListResponse({ abTests: tests });
  return core;
}

describe("ab-test picker", () => {
  test("renders columns, id, name, status, execution, and update time", async () => {
    const core = coreWithTests([
      summary({
        abTestId: "orders-AbCdEf1234",
        name: "orders",
        status: "ACTIVE",
        executionStatus: "STOPPED",
        updatedAt: new Date("2026-07-19T01:02:03.000Z"),
      }),
    ]);
    const r = renderScreen("/agentcore/eval/ab-test/list", { core });

    await waitForText(r.lastFrame, "orders");
    const frame = r.lastFrame()!;
    expect(frame).toContain("name");
    expect(frame).toContain("status");
    expect(frame).toContain("execution");
    expect(frame).toContain("updated UTC");
    expect(frame).toContain("STOPPED");
    expect(frame).toContain("2026-07-19 01:02");
  });

  test("calls listABTests once with exact Core options", async () => {
    const core = coreWithTests([summary()]);
    renderScreen("/agentcore/eval/ab-test/list", { core });

    await waitFor(() => core.eval.calls.some((call) => call.method === "listABTests"));
    expect(core.eval.calls.filter((call) => call.method === "listABTests")).toEqual([
      { method: "listABTests", args: [undefined, expect.any(Number), { region: "us-east-1" }] },
    ]);
  });

  test("shows the first-page empty state", async () => {
    const r = renderScreen("/agentcore/eval/ab-test/list");
    await waitForText(r.lastFrame, "No A/B tests found in this Region.");
  });

  test("bare get redirects to the picker", async () => {
    const core = coreWithTests([summary({ name: "redirected" })]);
    const r = renderScreen("/agentcore/eval/ab-test/get", { core });

    await waitForText(r.lastFrame, "redirected");
    expect(core.eval.calls[0]?.method).toBe("listABTests");
  });

  test("selection opens the matching A/B test hub", async () => {
    const core = coreWithTests([summary({ abTestId: "ab-test-1", name: "encoded" })]);
    core.eval.setAbTestGetResponse(getResponse());
    const r = renderScreen("/agentcore/eval/ab-test/list", { core });

    await waitForText(r.lastFrame, "encoded");
    await r.press("return");
    await waitForText(r.lastFrame, "agentcore → eval → ab-test → get → ab-test-1");
    await waitFor(() =>
      core.eval.calls.some((call) => call.method === "getABTest" && call.args[0] === "ab-test-1"),
    );
  });
});

describe("ab-test hub", () => {
  test("fetches the route id with exact Core options and renders its summary", async () => {
    const core = new TestCoreClient();
    core.eval.setAbTestGetResponse(getResponse());
    const r = renderScreen("/agentcore/eval/ab-test/get/ab-test-1", { core });

    await waitForText(r.lastFrame, "RUNNING");
    const frame = r.lastFrame()!;
    expect(frame).toContain("ab-test-1");
    expect(frame).toContain("orders-v2");
    expect(frame).toMatch(/variants\s+C 50% \/ T1 50%/);
    expect(frame).not.toContain("failureReason");
    expect(core.eval.calls.find((call) => call.method === "getABTest")).toEqual({
      method: "getABTest",
      args: ["ab-test-1", { region: "us-east-1" }],
    });
  });

  test("shows the error details only when the service provides them", async () => {
    const core = new TestCoreClient();
    core.eval.setAbTestGetResponse(
      getResponse({ status: "CREATE_FAILED", errorDetails: ["gateway not deployed"] }),
    );
    const r = renderScreen("/agentcore/eval/ab-test/get/ab-test-1", { core });

    await waitForText(r.lastFrame, "gateway not deployed");
    expect(r.lastFrame()).toMatch(/errors\s+gateway not deployed/);
  });

  test("detail action opens the full JSON with inline metrics", async () => {
    const core = new TestCoreClient();
    core.eval.setAbTestGetResponse(getResponse());
    const r = renderScreen("/agentcore/eval/ab-test/get/ab-test-1", { core });

    await waitForText(
      r.lastFrame,
      "show the full JSON definition, including per-evaluator metrics",
    );
    await r.press("return");
    await waitForText(r.lastFrame, "agentcore → eval → ab-test → get → ab-test-1 → json");
    expect(r.lastFrame()).toContain('"abTestId"');
    expect(r.lastFrame()).toContain('"evaluatorMetrics"');
  });

  test("retries a failed hub query without leaving the route", async () => {
    const core = new TestCoreClient();
    core.eval.setError(new Error("ab-test unavailable"));
    const r = renderScreen("/agentcore/eval/ab-test/get/ab-test-1", { core });

    await waitForText(r.lastFrame, "ab-test unavailable");
    expect(r.lastFrame()).toContain("[r] retry");

    core.eval.setError(undefined);
    core.eval.setAbTestGetResponse(getResponse());
    await r.write("r");
    await waitForText(r.lastFrame, "RUNNING");
  });
});
