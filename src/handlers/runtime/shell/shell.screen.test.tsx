import { afterEach, describe, expect, test } from "bun:test";
import { TuiHandoffController, TuiHandoffKey } from "../../../tui/handoff";
import { renderTuiAt } from "../../../tui";
import { DebugKey, EndpointKey, JsonKey, RegionKey } from "../../keys";
import { type Context, ValueContext } from "../../../router";
import type { RuntimeShellSession } from "../types";
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
  test("a shell selected from the bare picker returns to that picker", async () => {
    const controller = new TuiHandoffController();
    let handoffContext!: Context;
    const screen = renderScreen("/agentcore/runtime/shell", {
      core: core(),
      withContext: (ctx) => {
        handoffContext = ctx.withValue(TuiHandoffKey, controller);
        return handoffContext;
      },
    });

    await waitForText(screen.lastFrame, "checkout");
    await screen.press("return");
    await waitForText(screen.lastFrame, "prod");
    await screen.press("return");
    let handoff = controller.take();
    await waitFor(() => {
      handoff ??= controller.take();
      return handoff !== undefined;
    });
    const { streams } = ttyTestIO();

    expect(screen.core.runtime.calls.some((call) => call.method === "listRuntimes")).toBe(true);
    expect(screen.core.runtime.calls.some((call) => call.method === "listRuntimeEndpoints")).toBe(
      true,
    );
    await expect(
      handoff!({ ctx: handoffContext, core: screen.core, io: streams.io }),
    ).resolves.toEqual({
      resumePath: "/agentcore/runtime/shell",
    });
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

  test("a shell selected from Runtime details returns there after a nonzero exit", async () => {
    const controller = new TuiHandoffController();
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
    let handoffContext!: Context;
    const screen = renderScreen("/agentcore/runtime/get/checkout-AbCdEf1234", {
      core: value,
      withContext: (ctx) => {
        handoffContext = ctx.withValue(TuiHandoffKey, controller);
        return handoffContext;
      },
    });

    await waitForText(screen.lastFrame, "show the full JSON definition");
    await screen.press("down");
    await screen.press("return");
    await waitForText(screen.lastFrame, "prod");
    await screen.press("return");
    let handoff = controller.take();
    await waitFor(() => {
      handoff ??= controller.take();
      return handoff !== undefined;
    });
    const { streams } = ttyTestIO();

    await expect(
      handoff!({ ctx: handoffContext, core: screen.core, io: streams.io }),
    ).resolves.toEqual({
      resumePath: "/agentcore/runtime/get/checkout-AbCdEf1234",
    });
    expect(streams.stderr()).toContain("Session closed · exit 42");
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

  test("renderTuiAt remounts a requested origin after the shell ends", async () => {
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
      5000,
    );
    stdin.write("\x03");

    await rendering;
    expect(value.runtime.calls.filter((call) => call.method === "openRuntimeShell")).toHaveLength(
      1,
    );
  });
});
