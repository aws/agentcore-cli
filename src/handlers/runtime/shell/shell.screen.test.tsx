import { afterEach, describe, expect, test } from "bun:test";
import { renderTuiAt } from "../../../tui";
import { DebugKey, EndpointKey, JsonKey, RegionKey } from "../../keys";
import { ValueContext } from "../../../router";
import type { RuntimeShellSession } from "../types";
import {
  cleanupScreens,
  renderScreen,
  TestCoreClient,
  tick,
  type TtyInput,
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

async function interruptUntilExit(rendering: Promise<void>, stdin: TtyInput): Promise<void> {
  let settled = false;
  const tracked = rendering.finally(() => {
    settled = true;
  });
  while (!settled) {
    stdin.write("\x03");
    await tick();
  }
  await tracked;
}

describe("RuntimeShellScreen", () => {
  test("a direct Runtime route skips the Runtime picker", async () => {
    const screen = renderScreen("/agentcore/runtime/shell/checkout-AbCdEf1234", {
      core: core(),
    });

    await waitForText(screen.lastFrame, "prod");
    expect(screen.core.runtime.calls.some((call) => call.method === "listRuntimes")).toBe(false);
  });

  test("renderTuiAt returns to Runtime details after a nonzero shell exit", async () => {
    const value = core();
    const failedSession: RuntimeShellSession = {
      runtimeSessionId: "session-012345678901234567890123456789",
      kicked: false,
      exitCode: 42,
      send: async () => {},
      resize: async () => {},
      close: async () => {},
      async *[Symbol.asyncIterator]() {},
    };
    value.runtime.setShellSession(failedSession);
    const { streams, stdin } = ttyTestIO();
    const ctx = ValueContext.EmptyContext()
      .withValue(RegionKey, "us-east-1")
      .withValue(EndpointKey, undefined)
      .withValue(JsonKey, false)
      .withValue(DebugKey, false);
    const detailText = "show the full JSON definition";
    const rendering = renderTuiAt(
      "/agentcore/runtime/get/checkout-AbCdEf1234",
      ctx,
      value,
      streams.io,
    );

    await waitFor(() => streams.stdout().includes(detailText));
    const initialDetails = streams.stdout().split(detailText).length;
    stdin.write("\x1b[B");
    await waitFor(() => streams.stdout().includes("❯ shell"));
    stdin.write("\r");
    await waitFor(() => streams.stdout().includes("prod"));
    stdin.write("\r");
    await waitFor(() => streams.stderr().includes("Session closed · exit 42"));
    await waitFor(() => streams.stdout().split(detailText).length > initialDetails);

    await interruptUntilExit(rendering, stdin);
    expect(value.runtime.calls.filter((call) => call.method === "openRuntimeShell")).toHaveLength(
      1,
    );
  });

  test("renderTuiAt runs a direct shell to completion", async () => {
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

  test("renderTuiAt propagates unexpected shell failures", async () => {
    const value = core();
    value.runtime.setError(new Error("shell lookup failed"));
    const { streams } = ttyTestIO();
    const ctx = ValueContext.EmptyContext()
      .withValue(RegionKey, "us-east-1")
      .withValue(EndpointKey, undefined)
      .withValue(JsonKey, false)
      .withValue(DebugKey, false);

    await expect(
      renderTuiAt("/agentcore/runtime/shell/checkout-AbCdEf1234/prod", ctx, value, streams.io),
    ).rejects.toThrow("shell lookup failed");
  });

  test("renderTuiAt returns to a requested origin after the shell ends", async () => {
    const value = core();
    const { streams, stdin } = ttyTestIO();
    const ctx = ValueContext.EmptyContext()
      .withValue(RegionKey, "us-east-1")
      .withValue(EndpointKey, undefined)
      .withValue(JsonKey, false)
      .withValue(DebugKey, false);
    const rendering = renderTuiAt("/agentcore/runtime/shell", ctx, value, streams.io);

    await waitFor(() => streams.stdout().includes("checkout"));
    stdin.write("\r");
    await waitFor(() => streams.stdout().includes("prod"));
    stdin.write("\r");
    await waitFor(
      () => value.runtime.calls.filter((call) => call.method === "listRuntimes").length === 2,
    );

    await interruptUntilExit(rendering, stdin);
    expect(value.runtime.calls.filter((call) => call.method === "openRuntimeShell")).toHaveLength(
      1,
    );
  });
});
