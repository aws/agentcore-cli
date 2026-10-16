import { afterEach, describe, expect, test } from "bun:test";
import { renderTuiAt } from "../../../tui";
import { createRuntimeShellOpener } from "../../../core/runtimeShell";
import { DebugKey, EndpointKey, JsonKey, RegionKey } from "../../keys";
import { ValueContext } from "../../../router";
import { createRootHandler } from "../../index";
import type { RuntimeShellSession } from "../types";
import {
  cleanupScreens,
  createSilentLogger,
  renderScreen,
  TestCoreClient,
  TestGlobalConfigAccessor,
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

  test("CLI resume IDs survive endpoint selection", async () => {
    const value = core();
    const { streams, stdin } = ttyTestIO();
    const root = createRootHandler(value, {
      io: streams.io,
      logger: createSilentLogger(),
      globalConfigAccessor: new TestGlobalConfigAccessor(),
    });
    const sessionId = "session-012345678901234567890123456789";
    const rendering = root.route([
      "node",
      "agentcore",
      "runtime",
      "shell",
      "--id",
      "checkout-AbCdEf1234",
      "--session-id",
      sessionId,
      "--shell-id",
      "saved-shell",
      "--region",
      "us-east-1",
    ]);
    void rendering.catch(() => {});
    try {
      await waitFor(() => streams.stdout().includes("prod"));
      stdin.write("\r");
      await waitFor(() => value.runtime.calls.some((call) => call.method === "openRuntimeShell"));
      expect(
        value.runtime.calls.find((call) => call.method === "openRuntimeShell")?.args[0],
      ).toMatchObject({
        runtimeSessionId: sessionId,
        shellId: "saved-shell",
        qualifier: "prod",
      });
    } finally {
      await interruptUntilExit(rendering, stdin);
    }
  });

  test("renderTuiAt returns to Runtime details after a nonzero shell exit", async () => {
    const value = core();
    const failedSession: RuntimeShellSession = {
      runtimeSessionId: "session-012345678901234567890123456789",
      shellId: "server-shell",
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

  test("renderTuiAt completes successfully after retrying a failed direct shell", async () => {
    const value = core();
    const openShell = value.runtime.openRuntimeShell.bind(value.runtime);
    let attempts = 0;
    value.runtime.openRuntimeShell = async (request, options) => {
      if (++attempts === 1) throw new Error("shell failed");
      return openShell(request, options);
    };
    const { streams, stdin } = ttyTestIO();
    const ctx = ValueContext.EmptyContext()
      .withValue(RegionKey, "us-east-1")
      .withValue(EndpointKey, undefined)
      .withValue(JsonKey, false)
      .withValue(DebugKey, false);

    const rendering = renderTuiAt(
      "/agentcore/runtime/shell/checkout-AbCdEf1234/prod",
      ctx,
      value,
      streams.io,
    );
    void rendering.catch(() => {});
    try {
      await waitFor(() => streams.stdout().includes("Error: shell failed"));
      stdin.write("r");
      await rendering;
    } finally {
      await interruptUntilExit(
        rendering.catch(() => {}),
        stdin,
      );
    }

    expect(attempts).toBe(2);
    expect(value.runtime.calls.some((call) => call.method === "openRuntimeShell")).toBe(true);
    expect(streams.stderr()).toContain("Connected");
  });

  test.each([
    { key: "Ctrl+C", input: "\x03" },
    { key: "Escape", input: "\x1b" },
  ])("renderTuiAt propagates a failed direct shell when quitting with $key", async ({ input }) => {
    const value = core();
    const failure = new Error("shell failed");
    value.runtime.openRuntimeShell = async () => {
      throw failure;
    };
    const { streams, stdin } = ttyTestIO();
    const ctx = ValueContext.EmptyContext()
      .withValue(RegionKey, "us-east-1")
      .withValue(EndpointKey, undefined)
      .withValue(JsonKey, false)
      .withValue(DebugKey, false);
    let settled = false;
    const rendering = renderTuiAt(
      "/agentcore/runtime/shell/checkout-AbCdEf1234/prod",
      ctx,
      value,
      streams.io,
    ).finally(() => {
      settled = true;
    });
    void rendering.catch(() => {});
    try {
      await waitFor(() => streams.stdout().includes("Error: shell failed"));
      stdin.write(input);
      await waitFor(() => settled);
      await expect(rendering).rejects.toMatchObject({
        message: failure.message,
        cause: failure,
        exitCode: 1,
      });
    } finally {
      await interruptUntilExit(
        rendering.catch(() => {}),
        stdin,
      );
    }
  });

  test("keeps rejected shell connections in the TUI with retry and endpoint back navigation", async () => {
    const value = core();
    const rejectShell = createRuntimeShellOpener({
      createClient: () => ({
        openShell: async () => {
          throw new Error("Server rejected WebSocket connection: HTTP 400");
        },
      }),
    });
    const openShell = value.runtime.openRuntimeShell.bind(value.runtime);
    let attempts = 0;
    let reported: Error | undefined;
    value.runtime.openRuntimeShell = async (request, options) => {
      if (++attempts > 2) return openShell(request, options);
      try {
        return await rejectShell(request, options);
      } catch (error) {
        reported = error as Error;
        throw error;
      }
    };
    const { streams, stdin } = ttyTestIO();
    const ctx = ValueContext.EmptyContext()
      .withValue(RegionKey, "us-east-1")
      .withValue(EndpointKey, undefined)
      .withValue(JsonKey, false)
      .withValue(DebugKey, false);

    const rendering = renderTuiAt(
      "/agentcore/runtime/shell/checkout-AbCdEf1234",
      ctx,
      value,
      streams.io,
    );
    void rendering.catch(() => {});
    try {
      await waitFor(() => streams.stdout().includes("updated UTC"));
      stdin.write("\r");
      const errorText = "HTTP 400";
      await waitFor(() => streams.stdout().includes(errorText));
      expect(streams.stdout()).toContain("checkout-AbCdEf1234");
      expect(streams.stdout()).toContain("retry");
      expect(streams.stdout()).toContain("back");
      expect(streams.stdout().replace(/\s+/g, "")).toContain(reported!.message.replace(/\s+/g, ""));
      expect(streams.stdout().replace(/\s+/g, " ")).toContain(
        "If this Runtime is managed by a harness",
      );
      expect(streams.stdout()).toContain("\nIf this Runtime");
      expect(streams.stdout().replace(/\s+/g, " ")).toContain(
        "agentcore harness shell --id <harness-id>",
      );
      const errorsBeforeRetry = streams.stdout().split(errorText).length;
      stdin.write("r");
      await waitFor(() => attempts === 2);
      await waitFor(() => streams.stdout().split(errorText).length > errorsBeforeRetry);
      const selectionsBeforeBack = streams.stdout().split("[enter] select").length;
      stdin.write("\x1b");
      await waitFor(() => streams.stdout().includes("choose an endpoint to open a shell"));
      await waitFor(() => streams.stdout().split("[enter] select").length > selectionsBeforeBack);
      expect(value.runtime.calls.some((call) => call.method === "listRuntimes")).toBe(false);
      stdin.write("\r");
      await waitFor(() => streams.stderr().includes("Session closed"));
      expect(attempts).toBe(3);
    } finally {
      await interruptUntilExit(rendering, stdin);
    }
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
