import { afterEach, describe, expect, test } from "bun:test";
import { TuiHandoffController, TuiHandoffKey } from "../../../tui/handoff";
import { renderTuiAt } from "../../../tui";
import { DebugKey, EndpointKey, JsonKey, RegionKey } from "../../keys";
import { ValueContext } from "../../../router";
import {
  cleanupScreens,
  renderScreen,
  TestCoreClient,
  ttyTestIO,
  waitFor,
  waitForText,
} from "../../../testing";

afterEach(cleanupScreens);

function core() {
  const value = new TestCoreClient();
  value.runtime.setListResponse({
    agentRuntimes: [
      {
        agentRuntimeArn:
          "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/checkout-AbCdEf1234",
        agentRuntimeId: "checkout-AbCdEf1234",
        agentRuntimeName: "checkout",
        agentRuntimeVersion: "1",
        description: "Checkout Runtime",
        status: "READY",
        lastUpdatedAt: new Date("2026-09-03T00:00:00Z"),
      },
    ],
  });
  value.runtime.setListEndpointsResponse({
    runtimeEndpoints: [
      {
        name: "prod",
        id: "prod",
        liveVersion: "1",
        status: "READY",
        agentRuntimeEndpointArn:
          "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime-endpoint/prod",
        agentRuntimeArn:
          "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/checkout-AbCdEf1234",
        createdAt: new Date("2026-09-03T00:00:00Z"),
        lastUpdatedAt: new Date("2026-09-03T00:00:00Z"),
      },
    ],
  });
  value.runtime.setGetResponse({
    agentRuntimeArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/checkout-AbCdEf1234",
    agentRuntimeId: "checkout-AbCdEf1234",
    agentRuntimeName: "checkout",
    agentRuntimeVersion: "1",
    createdAt: new Date("2026-09-03T00:00:00Z"),
    lastUpdatedAt: new Date("2026-09-03T00:00:00Z"),
    status: "READY",
    roleArn: "arn:aws:iam::123456789012:role/runtime",
    networkConfiguration: { networkMode: "PUBLIC" },
    lifecycleConfiguration: {
      idleRuntimeSessionTimeout: 900,
      maxLifetime: 28_800,
    },
  });
  return value;
}

describe("RuntimeShellScreen", () => {
  test("selects a Runtime and endpoint, then requests one post-Ink handoff", async () => {
    const controller = new TuiHandoffController();
    const screen = renderScreen("/agentcore/runtime/shell", {
      core: core(),
      withContext: (ctx) => ctx.withValue(TuiHandoffKey, controller),
    });

    await waitForText(screen.lastFrame, "checkout");
    await screen.press("return");
    await waitForText(screen.lastFrame, "prod");
    await screen.press("return");
    await waitFor(() => controller.take() !== undefined);

    expect(screen.core.runtime.calls.some((call) => call.method === "listRuntimes")).toBe(true);
    expect(screen.core.runtime.calls.some((call) => call.method === "listRuntimeEndpoints")).toBe(
      true,
    );
  });

  test("a direct Runtime route skips the Runtime picker", async () => {
    const controller = new TuiHandoffController();
    const screen = renderScreen("/agentcore/runtime/shell/checkout-AbCdEf1234", {
      core: core(),
      withContext: (ctx) => ctx.withValue(TuiHandoffKey, controller),
    });

    await waitForText(screen.lastFrame, "prod");
    expect(screen.core.runtime.calls.some((call) => call.method === "listRuntimes")).toBe(false);
  });

  test("renderTuiAt unmounts Ink before executing the shell handoff", async () => {
    const value = core();
    const { streams } = ttyTestIO();
    const ctx = ValueContext.EmptyContext()
      .withValue(RegionKey, "us-east-1")
      .withValue(EndpointKey, undefined)
      .withValue(JsonKey, false)
      .withValue(DebugKey, false);

    await renderTuiAt("/agentcore/runtime/shell/checkout-AbCdEf1234/prod", ctx, value, streams.io);

    expect(value.runtime.calls.some((call) => call.method === "openRuntimeShell")).toBe(true);
    expect(streams.stderr()).toContain("Connected");
  });
});
