import { test, expect, describe, afterEach } from "bun:test";
import type {
  AgentRuntime,
  AgentRuntimeEndpoint,
  GetAgentRuntimeEndpointResponse,
  GetAgentRuntimeResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { createRootHandler } from "../handlers";
import { DebugKey, EndpointKey, JsonKey, RegionKey } from "../handlers/keys";
import { CommandKey, compile, type Context, ValueContext } from "../router";
import {
  cleanupScreens,
  createSilentLogger,
  renderScreen,
  TestCoreClient,
  testIO,
  tick,
  waitFor,
  waitForText,
} from "../testing";
import { JsonRendererKey, renderTuiAt } from "../tui";

afterEach(cleanupScreens);

const runtimeEndpointUrl = "https://runtime.test";

function runtime(overrides: Partial<AgentRuntime> = {}): AgentRuntime {
  return {
    agentRuntimeArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/runtime-123",
    agentRuntimeId: "runtime-123",
    agentRuntimeVersion: "7",
    agentRuntimeName: "checkout",
    description: "Checkout Runtime",
    lastUpdatedAt: new Date("2026-07-20T12:34:56.000Z"),
    status: "READY",
    ...overrides,
  };
}

function getRuntimeResponse(
  overrides: Partial<GetAgentRuntimeResponse> = {},
): GetAgentRuntimeResponse {
  return {
    agentRuntimeArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/runtime-123",
    agentRuntimeName: "checkout",
    agentRuntimeId: "runtime-123",
    agentRuntimeVersion: "7",
    createdAt: new Date("2026-07-19T01:02:03.000Z"),
    lastUpdatedAt: new Date("2026-07-20T12:34:56.000Z"),
    roleArn: "arn:aws:iam::123456789012:role/runtime-role",
    networkConfiguration: { networkMode: "PUBLIC" },
    status: "READY",
    lifecycleConfiguration: {
      idleRuntimeSessionTimeout: 900,
      maxLifetime: 28_800,
    },
    ...overrides,
  };
}

function endpoint(overrides: Partial<AgentRuntimeEndpoint> = {}): AgentRuntimeEndpoint {
  return {
    name: "prod",
    liveVersion: "7",
    agentRuntimeEndpointArn:
      "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/runtime-123/endpoint/prod",
    agentRuntimeArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/runtime-123",
    status: "READY",
    id: "prod",
    createdAt: new Date("2026-07-19T01:02:03.000Z"),
    lastUpdatedAt: new Date("2026-07-20T12:34:56.000Z"),
    ...overrides,
  };
}

function getEndpointResponse(
  overrides: Partial<GetAgentRuntimeEndpointResponse> = {},
): GetAgentRuntimeEndpointResponse {
  return {
    liveVersion: "7",
    targetVersion: "8",
    agentRuntimeEndpointArn:
      "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/runtime-123/endpoint/prod",
    agentRuntimeArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/runtime-123",
    status: "READY",
    createdAt: new Date("2026-07-19T01:02:03.000Z"),
    lastUpdatedAt: new Date("2026-07-20T12:34:56.000Z"),
    name: "prod",
    id: "prod",
    ...overrides,
  };
}

function runtimeCore(): TestCoreClient {
  const core = new TestCoreClient();
  core.runtime.setListResponse({ agentRuntimes: [runtime()] });
  core.runtime.setGetResponse(getRuntimeResponse());
  core.runtime.setListVersionsResponse({ agentRuntimes: [runtime()] });
  core.runtime.setGetVersionResponse(getRuntimeResponse());
  core.runtime.setListEndpointsResponse({ runtimeEndpoints: [endpoint()] });
  core.runtime.setGetEndpointResponse(getEndpointResponse());
  return core;
}

function runtimeContext(core: TestCoreClient): Context {
  const rootCommand = compile(
    createRootHandler(core, { io: testIO().io, logger: createSilentLogger() }),
    ValueContext.EmptyContext(),
  );

  return ValueContext.EmptyContext()
    .withValue(CommandKey, rootCommand)
    .withValue(RegionKey, "us-east-1")
    .withValue(EndpointKey, runtimeEndpointUrl)
    .withValue(JsonKey, false)
    .withValue(DebugKey, false)
    .withValue(JsonRendererKey, { renderJson: () => {} });
}

function expectEndpointPropagation(core: TestCoreClient, methods: readonly string[]): void {
  for (const method of methods) {
    const calls = core.runtime.calls.filter((call) => call.method === method);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.args.at(-1)).toEqual({
        region: "us-east-1",
        endpointUrl: runtimeEndpointUrl,
      });
    }
  }
}

interface TtyInput extends NodeJS.ReadStream {
  write(chunk: string): boolean;
}

function ttyTestIO(): { streams: ReturnType<typeof testIO>; stdin: TtyInput } {
  const streams = testIO({ isTTY: true });
  const stdin = streams.io.stdin as TtyInput;
  stdin.setRawMode = function () {
    return this;
  };
  stdin.ref = function () {
    return this;
  };
  stdin.unref = function () {
    return this;
  };
  Object.defineProperties(streams.io.stdout, {
    columns: { configurable: true, value: 100 },
    rows: { configurable: true, value: 40 },
  });
  return { streams, stdin };
}

// RouterScreen is the interactive command menu. These tests mount it through the
// real Root at a command path and drive it with key presses, asserting on the
// rendered frames — behavior a user would see, not internal state.

describe("menu rendering", () => {
  test("lists the current command's subcommands with their descriptions", async () => {
    const r = renderScreen("/agentcore");
    await waitForText(r.lastFrame, "harness");

    const frame = r.lastFrame()!;
    expect(frame).toContain("harness");
    expect(frame).toContain("manage agentcore harnesses");
    expect(frame).toContain("runtime");
    expect(frame).toContain("inspect AgentCore Runtimes");
    expect(frame).toContain("config");
    expect(frame).toContain("read/write global config values");
    r.unmount();
  });

  test("shows the command description in the header", async () => {
    const r = renderScreen("/agentcore");
    await waitForText(r.lastFrame, "the platform for production AI agents");
    r.unmount();
  });

  test("renders the harness subcommands when mounted at the harness path", async () => {
    const r = renderScreen("/agentcore/harness");
    await waitForText(r.lastFrame, "list");

    const frame = r.lastFrame()!;
    for (const sub of ["get", "list", "create", "update", "delete", "invoke", "exec"]) {
      expect(frame).toContain(sub);
    }
    r.unmount();
  });

  test("highlights the first option by default", async () => {
    const r = renderScreen("/agentcore");
    await waitForText(r.lastFrame, "harness");
    // The focus caret marks the highlighted row; the first option is harness.
    expect(r.lastFrame()).toContain("❯ harness");
    r.unmount();
  });
});

describe("filtering", () => {
  test("typing narrows the options to matches", async () => {
    const r = renderScreen("/agentcore/harness");
    await waitForText(r.lastFrame, "list");

    await r.write("cr"); // matches "create" only
    await waitForText(r.lastFrame, "❯ create");

    const frame = r.lastFrame()!;
    expect(frame).toContain("create");
    expect(frame).not.toContain("list");
    expect(frame).not.toContain("delete");
    r.unmount();
  });

  test("filtering is case-insensitive", async () => {
    const r = renderScreen("/agentcore/harness");
    await waitForText(r.lastFrame, "list");

    await r.write("LIST");
    await waitForText(r.lastFrame, "❯ list");
    r.unmount();
  });

  test("shows a no-matches message when nothing matches", async () => {
    const r = renderScreen("/agentcore/harness");
    await waitForText(r.lastFrame, "list");

    await r.write("zzz");
    await waitForText(r.lastFrame, "No matches");
    r.unmount();
  });
});

describe("navigation", () => {
  test("down arrow moves the highlight to the next option", async () => {
    const r = renderScreen("/agentcore");
    await waitForText(r.lastFrame, "❯ harness");

    await r.press("down");
    await waitForText(r.lastFrame, "❯ identity");

    await r.press("down");
    await waitForText(r.lastFrame, "❯ runtime");
    r.unmount();
  });

  test("up arrow does not move past the first option", async () => {
    const r = renderScreen("/agentcore");
    await waitForText(r.lastFrame, "❯ harness");

    await r.press("up");
    await tick(20);
    // Still on the first option.
    expect(r.lastFrame()).toContain("❯ harness");
    r.unmount();
  });

  test("enter navigates into the highlighted subcommand's screen", async () => {
    const r = renderScreen("/agentcore");
    await waitForText(r.lastFrame, "❯ harness");

    await r.press("return");
    // The harness screen is itself a RouterScreen showing harness subcommands.
    await waitForText(r.lastFrame, "agentcore → harness");
    expect(r.lastFrame()).toContain("list");
    r.unmount();
  });

  test("esc from a nested menu returns to the parent menu", async () => {
    const r = renderScreen("/agentcore/harness");
    await waitForText(r.lastFrame, "agentcore → harness");

    await r.press("escape");
    // Back at the root menu (breadcrumb no longer includes harness).
    await waitForText(r.lastFrame, "the platform for production AI agents");
    expect(r.lastFrame()).toContain("❯ harness");
    r.unmount();
  });

  test("esc at the root menu is a no-op (no parent to go to)", async () => {
    const r = renderScreen("/agentcore");
    await waitForText(r.lastFrame, "❯ harness");

    await r.press("escape");
    await tick(20);
    expect(r.lastFrame()).toContain("❯ harness");
    r.unmount();
  });

  test("ctrl+c is handled (quit) without crashing", async () => {
    const r = renderScreen("/agentcore");
    await waitForText(r.lastFrame, "❯ harness");

    // ctrl+c is 0x03; the menu's handler calls exit(), which unmounts the app.
    // Driving the branch must not throw; after exit the renderer stops updating.
    await r.write(String.fromCharCode(3));
    await tick(20);
    r.unmount();
  });

  test.each([
    [
      "versions",
      1,
      "agentcore → runtime → version → list → runtime-123",
      "2026-07-20T12:34:56.000Z",
      "agentcore → runtime → version → get → runtime-123 → 7",
      '"agentRuntimeVersion"',
      "listRuntimeVersions",
      "getRuntimeVersion",
    ],
    [
      "endpoints",
      2,
      "agentcore → runtime → endpoint → list → runtime-123",
      "prod",
      "agentcore → runtime → endpoint → get → runtime-123 → prod",
      '"agentRuntimeEndpointArn"',
      "listRuntimeEndpoints",
      "getRuntimeEndpoint",
    ],
  ] as const)(
    "navigates from Root through Runtime %s and escapes each explicit boundary",
    async (
      _destination,
      hubDownPresses,
      scopedListBreadcrumb,
      scopedListValue,
      jsonBreadcrumb,
      jsonField,
      listMethod,
      getMethod,
    ) => {
      const core = runtimeCore();
      const r = renderScreen("/agentcore", {
        core,
        ctx: runtimeContext(core),
      });

      await waitForText(r.lastFrame, "❯ harness");
      await r.press("down");
      await r.press("return");
      await waitForText(r.lastFrame, "agentcore → runtime → inspect AgentCore Runtimes");

      await r.press("down");
      await r.press("return");
      await waitForText(r.lastFrame, "agentcore → runtime → list");
      await waitForText(r.lastFrame, "checkout");

      await r.press("return");
      await waitForText(r.lastFrame, "agentcore → runtime → get → runtime-123");
      await waitForText(r.lastFrame, "show the full JSON definition");

      for (let index = 0; index < hubDownPresses; index += 1) {
        await r.press("down");
      }
      await r.press("return");
      await waitForText(r.lastFrame, scopedListBreadcrumb);
      await waitForText(r.lastFrame, scopedListValue);

      await r.press("return");
      await waitForText(r.lastFrame, jsonBreadcrumb);
      await waitForText(r.lastFrame, jsonField);

      await r.press("escape");
      await waitForText(r.lastFrame, scopedListBreadcrumb);
      await waitForText(r.lastFrame, scopedListValue);
      await r.press("escape");
      await waitForText(r.lastFrame, "agentcore → runtime → get → runtime-123");
      await waitForText(r.lastFrame, "show the full JSON definition");
      await r.press("escape");
      await waitForText(r.lastFrame, "agentcore → runtime → list");
      await waitForText(r.lastFrame, "checkout");
      await r.press("escape");
      await waitForText(r.lastFrame, "agentcore → runtime → inspect AgentCore Runtimes");
      await r.press("escape");
      await waitForText(r.lastFrame, "the platform for production AI agents");
      expect(r.lastFrame()).toContain("❯ harness");

      const callsAtRoot = core.runtime.calls.length;
      await r.press("escape");
      expect(r.lastFrame()).toContain("❯ harness");
      expect(core.runtime.calls).toHaveLength(callsAtRoot);

      expectEndpointPropagation(core, ["listRuntimes", "getRuntime", listMethod, getMethod]);
    },
  );
});

describe("Runtime TUI exit", () => {
  test.each([
    [
      "Runtime list",
      "/agentcore/runtime/list",
      "listRuntimes",
      0,
      (core: TestCoreClient) =>
        core.runtime.setListResponse({
          agentRuntimes: [runtime()],
          nextToken: "page-2",
        }),
    ],
    [
      "version list",
      "/agentcore/runtime/version/list/runtime-123",
      "listRuntimeVersions",
      1,
      (core: TestCoreClient) =>
        core.runtime.setListVersionsResponse({
          agentRuntimes: [runtime()],
          nextToken: "page-2",
        }),
    ],
    [
      "endpoint list",
      "/agentcore/runtime/endpoint/list/runtime-123",
      "listRuntimeEndpoints",
      1,
      (core: TestCoreClient) =>
        core.runtime.setListEndpointsResponse({
          runtimeEndpoints: [endpoint()],
          nextToken: "page-2",
        }),
    ],
  ] as const)(
    "Ctrl+C exits the production %s and ignores paging input after exit",
    async (_label, path, method, tokenIndex, configure) => {
      const core = new TestCoreClient();
      configure(core);
      const { streams, stdin } = ttyTestIO();
      const renderPromise = renderTuiAt(path, runtimeContext(core), core, streams.io);
      const methodCalls = () => core.runtime.calls.filter((call) => call.method === method);

      await waitFor(() => methodCalls().length > 0 && streams.stdout().includes("page 1 · more →"));
      await tick();
      const callsBeforeExit = methodCalls().length;

      stdin.write(String.fromCharCode(3));
      await expect(renderPromise).resolves.toBeUndefined();

      stdin.write("l");
      await tick(50);
      expect(methodCalls()).toHaveLength(callsBeforeExit);
      expect(methodCalls().some((call) => call.args[tokenIndex] === "page-2")).toBe(false);
    },
  );
});
