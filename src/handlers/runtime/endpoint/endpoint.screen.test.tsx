import { afterEach, describe, expect, test } from "bun:test";
import type {
  AgentRuntime,
  AgentRuntimeEndpoint,
  GetAgentRuntimeEndpointResponse,
  ListAgentRuntimeEndpointsResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import {
  cleanupScreens,
  renderScreen,
  TestCoreClient,
  waitFor,
  waitForText,
} from "../../../testing";

afterEach(cleanupScreens);

function runtime(overrides: Partial<AgentRuntime> = {}): AgentRuntime {
  return {
    agentRuntimeArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/runtime-123",
    agentRuntimeId: "runtime-123",
    agentRuntimeVersion: "3",
    agentRuntimeName: "checkout",
    description: "Checkout Runtime",
    lastUpdatedAt: new Date("2026-07-20T12:34:56.000Z"),
    status: "READY",
    ...overrides,
  };
}

function endpoint(overrides: Partial<AgentRuntimeEndpoint> = {}): AgentRuntimeEndpoint {
  return {
    name: "prod",
    liveVersion: "3",
    targetVersion: "99",
    agentRuntimeEndpointArn:
      "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/runtime-123/endpoint/prod",
    agentRuntimeArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/runtime-123",
    status: "READY",
    id: "prod",
    description: "Production endpoint",
    createdAt: new Date("2026-07-19T01:02:03.000Z"),
    lastUpdatedAt: new Date("2026-07-20T12:34:56.000Z"),
    ...overrides,
  };
}

function getEndpointResponse(
  overrides: Partial<GetAgentRuntimeEndpointResponse> = {},
): GetAgentRuntimeEndpointResponse {
  return {
    liveVersion: "3",
    targetVersion: "4",
    agentRuntimeEndpointArn:
      "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/runtime-123/endpoint/prod",
    agentRuntimeArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/runtime-123",
    description: "Production endpoint",
    status: "READY",
    createdAt: new Date("2026-07-19T01:02:03.000Z"),
    lastUpdatedAt: new Date("2026-07-20T12:34:56.000Z"),
    name: "prod",
    id: "prod",
    ...overrides,
  };
}

async function waitForRuntimePicker(lastFrame: () => string | undefined): Promise<void> {
  await waitFor(() => {
    const frame = lastFrame() ?? "";
    return (
      frame.includes("agentcore → runtime → endpoint → list") &&
      !frame.includes("agentcore → runtime → endpoint → list → runtime-123") &&
      frame.includes("checkout")
    );
  });
}

describe("Runtime endpoint flow", () => {
  test("uses the Runtime picker to scope an unscoped endpoint list", async () => {
    const runtimeId = "runtime/blue one";
    const core = new TestCoreClient();
    core.runtime.setListResponse({
      agentRuntimes: [runtime({ agentRuntimeId: runtimeId, agentRuntimeName: "pick-runtime" })],
    });
    core.runtime.setListEndpointsResponse({
      runtimeEndpoints: [endpoint()],
    });
    const r = renderScreen("/agentcore/runtime/endpoint/list", { core });

    await waitForText(r.lastFrame, "pick-runtime");
    await r.press("return");
    await waitForText(r.lastFrame, "agentcore → runtime → endpoint → list → runtime/blue one");
    await waitForText(r.lastFrame, "prod");
    expect(
      core.runtime.calls.some(
        (call) => call.method === "listRuntimeEndpoints" && call.args[0] === runtimeId,
      ),
    ).toBe(true);
  });

  test("skips parent selection when the Runtime ID is already scoped", async () => {
    const core = new TestCoreClient();
    core.runtime.setListEndpointsResponse({
      runtimeEndpoints: [endpoint()],
    });
    const r = renderScreen("/agentcore/runtime/endpoint/list/runtime-123", { core });

    await waitForText(r.lastFrame, "prod");
    expect(core.runtime.calls.some((call) => call.method === "listRuntimes")).toBe(false);
    expect(
      core.runtime.calls.some(
        (call) => call.method === "listRuntimeEndpoints" && call.args[0] === "runtime-123",
      ),
    ).toBe(true);
  });

  test("calls listRuntimeEndpoints with exact scope, page size, and options", async () => {
    const core = new TestCoreClient();
    core.runtime.setListEndpointsResponse({
      runtimeEndpoints: [endpoint()],
    });
    renderScreen("/agentcore/runtime/endpoint/list/runtime-123", { core });

    await waitFor(() =>
      core.runtime.calls.some(
        (call) => call.method === "listRuntimeEndpoints" && call.args[2] === 32,
      ),
    );
    expect(core.runtime.calls.filter((call) => call.method === "listRuntimeEndpoints")).toEqual([
      {
        method: "listRuntimeEndpoints",
        args: [
          "runtime-123",
          undefined,
          32,
          {
            region: "us-east-1",
            endpointUrl: undefined,
          },
        ],
      },
    ]);
  });

  test("renders qualifier, live version, status, and update time without invented columns", async () => {
    const core = new TestCoreClient();
    core.runtime.setListEndpointsResponse({
      runtimeEndpoints: [
        endpoint({
          name: "production",
          liveVersion: "7",
          targetVersion: "target-hidden",
          status: "UPDATE_FAILED",
          lastUpdatedAt: new Date("2026-07-18T02:00:00.000Z"),
        }),
      ],
    });
    const r = renderScreen("/agentcore/runtime/endpoint/list/runtime-123", { core });

    await waitForText(r.lastFrame, "production");
    const frame = r.lastFrame()!;
    expect(frame).toContain("qualifier");
    expect(frame).toContain("live");
    expect(frame).toContain("status");
    expect(frame).toContain("lastUpdatedAt");
    expect(frame).toContain("UPDATE_FAILED");
    expect(frame).toContain("2026-07-18T02:00:00.000Z");
    expect(frame).not.toContain("protocol");
    expect(frame).not.toContain("target");
    expect(frame).not.toContain("target-hidden");
  });

  test("keeps qualifier and live version when narrow", async () => {
    const core = new TestCoreClient();
    core.runtime.setListEndpointsResponse({
      runtimeEndpoints: [
        endpoint({
          name: "visible-endpoint",
          liveVersion: "7",
          status: "UPDATE_FAILED",
          lastUpdatedAt: new Date("2026-07-18T02:00:00.000Z"),
        }),
      ],
    });
    const r = renderScreen("/agentcore/runtime/endpoint/list/runtime-123", { core });

    await r.resize(50);
    await waitForText(r.lastFrame, "visible-endpoint");
    const frame = r.lastFrame()!;
    expect(frame).toContain("qualifier");
    expect(frame).toContain("live");
    expect(frame).toContain("visible-endpoint");
    expect(frame).toContain("7");
    expect(frame).not.toContain("status");
    expect(frame).not.toContain("lastUpdatedAt");
    expect(frame).not.toContain("UPDATE_FAILED");
  });

  test("shows the Runtime-scoped empty state", async () => {
    const r = renderScreen("/agentcore/runtime/endpoint/list/runtime-123");

    await waitForText(r.lastFrame, "This Runtime has no endpoints.");
    expect(r.lastFrame()).toContain("runtime-123");
  });

  test("pages forward and backward using token history", async () => {
    const core = new TestCoreClient();
    core.runtime.setListEndpointsResponse({
      runtimeEndpoints: [endpoint({ name: "page-one" })],
      nextToken: "page-2",
    });
    core.runtime.setListEndpointsResponse(
      {
        runtimeEndpoints: [endpoint({ name: "page-two" })],
      },
      "page-2",
    );
    const r = renderScreen("/agentcore/runtime/endpoint/list/runtime-123", { core });

    await waitForText(r.lastFrame, "page 1 · more →");
    await r.write("l");
    await waitForText(r.lastFrame, "page-two");
    expect(core.runtime.calls.at(-1)?.args[1]).toBe("page-2");

    await r.write("h");
    await waitForText(r.lastFrame, "page-one");
    expect(core.runtime.calls.at(-1)?.args[1]).toBeUndefined();
  });

  test("resizing resets to page one with the terminal-derived page size", async () => {
    const core = new TestCoreClient();
    core.runtime.setListEndpointsResponse({
      runtimeEndpoints: [endpoint({ name: "page-one" })],
      nextToken: "page-2",
    });
    core.runtime.setListEndpointsResponse(
      {
        runtimeEndpoints: [endpoint({ name: "page-two" })],
      },
      "page-2",
    );
    const r = renderScreen("/agentcore/runtime/endpoint/list/runtime-123", { core });

    await waitForText(r.lastFrame, "page 1 · more →");
    await r.write("l");
    await waitForText(r.lastFrame, "page-two");
    const callsBeforeResize = core.runtime.calls.filter(
      (call) => call.method === "listRuntimeEndpoints",
    ).length;

    await r.resize(100, 20);
    await waitFor(() => {
      const calls = core.runtime.calls.filter((call) => call.method === "listRuntimeEndpoints");
      return (
        calls.length > callsBeforeResize &&
        calls.at(-1)?.args[1] === undefined &&
        calls.at(-1)?.args[2] === 12
      );
    });
    await waitForText(r.lastFrame, "page-one");
    expect(r.lastFrame()).toContain("page 1 · more →");
    const callsAfterResize = core.runtime.calls
      .filter((call) => call.method === "listRuntimeEndpoints")
      .slice(callsBeforeResize);
    expect(callsAfterResize.length).toBeGreaterThan(0);
    expect(callsAfterResize.every((call) => call.args[1] === undefined)).toBe(true);
  });

  test("retains rows and ignores page keys during a page transition", async () => {
    const core = new TestCoreClient();
    core.runtime.setListEndpointsResponse({
      runtimeEndpoints: [endpoint({ name: "stable-page-one" })],
      nextToken: "page-2",
    });
    core.runtime.setListEndpointsResponse(
      {
        runtimeEndpoints: [endpoint({ name: "settled-page-two" })],
      },
      "page-2",
    );
    const nextPage = Promise.withResolvers<void>();
    const listEndpoints = core.runtime.listRuntimeEndpoints.bind(core.runtime);
    core.runtime.listRuntimeEndpoints = async (...args) => {
      const response = await listEndpoints(...args);
      if (args[1] === "page-2") await nextPage.promise;
      return response;
    };
    const r = renderScreen("/agentcore/runtime/endpoint/list/runtime-123", { core });

    await waitForText(r.lastFrame, "page 1 · more →");
    await r.write("l");
    await waitForText(r.lastFrame, "loading page 2…");
    expect(r.lastFrame()).toContain("stable-page-one");

    const callsDuringTransition = core.runtime.calls.length;
    await r.write("l");
    await r.write("h");
    expect(core.runtime.calls).toHaveLength(callsDuringTransition);

    nextPage.resolve();
    await waitForText(r.lastFrame, "settled-page-two");
  });

  test("filters only the loaded page without paging on h or l", async () => {
    const core = new TestCoreClient();
    core.runtime.setListEndpointsResponse({
      runtimeEndpoints: [endpoint({ name: "production" })],
      nextToken: "page-2",
    });
    const r = renderScreen("/agentcore/runtime/endpoint/list/runtime-123", { core });

    await waitForText(r.lastFrame, "page 1 · more →");
    await r.write("/");
    await r.write("l");
    await r.write("h");
    await waitForText(r.lastFrame, "/ Filter this page: lh");
    expect(r.lastFrame()).toContain("No matches on this page");
    expect(
      core.runtime.calls.some(
        (call) => call.method === "listRuntimeEndpoints" && call.args[1] === "page-2",
      ),
    ).toBe(false);
  });

  test("retries errors and keeps Esc active in loading, error, and empty states", async () => {
    const retryCore = new TestCoreClient();
    retryCore.runtime.setError(new Error("endpoint access denied"));
    const retry = renderScreen("/agentcore/runtime/endpoint/list/runtime-123", { core: retryCore });
    await waitForText(retry.lastFrame, "endpoint access denied");
    expect(retry.lastFrame()).toContain("Runtime runtime-123");
    expect(retry.lastFrame()).toContain("[r] retry");
    retryCore.runtime.setError(undefined);
    retryCore.runtime.setListEndpointsResponse({
      runtimeEndpoints: [endpoint({ name: "recovered" })],
    });
    const callsBeforeRetry = retryCore.runtime.calls.length;
    await retry.write("r");
    await waitForText(retry.lastFrame, "recovered");
    expect(retryCore.runtime.calls).toHaveLength(callsBeforeRetry + 1);
    retry.unmount();

    const loadingCore = new TestCoreClient();
    loadingCore.runtime.setListResponse({
      agentRuntimes: [runtime()],
    });
    const pending = Promise.withResolvers<ListAgentRuntimeEndpointsResponse>();
    loadingCore.runtime.listRuntimeEndpoints = async () => pending.promise;
    const loading = renderScreen("/agentcore/runtime/endpoint/list", {
      core: loadingCore,
    });
    await waitForText(loading.lastFrame, "checkout");
    await loading.press("return");
    await waitForText(loading.lastFrame, "Loading endpoints for Runtime runtime-123…");
    await loading.press("escape");
    await waitForRuntimePicker(loading.lastFrame);
    loading.unmount();

    const errorCore = new TestCoreClient();
    errorCore.runtime.setListResponse({
      agentRuntimes: [runtime()],
    });
    errorCore.runtime.listRuntimeEndpoints = async () => {
      throw new Error("failed");
    };
    const error = renderScreen("/agentcore/runtime/endpoint/list", { core: errorCore });
    await waitForText(error.lastFrame, "checkout");
    await error.press("return");
    await waitForText(error.lastFrame, "failed");
    await error.press("escape");
    await waitForRuntimePicker(error.lastFrame);
    error.unmount();

    const emptyCore = new TestCoreClient();
    emptyCore.runtime.setListResponse({
      agentRuntimes: [runtime()],
    });
    const empty = renderScreen("/agentcore/runtime/endpoint/list", { core: emptyCore });
    await waitForText(empty.lastFrame, "checkout");
    await empty.press("return");
    await waitForText(empty.lastFrame, "This Runtime has no endpoints.");
    await empty.press("escape");
    await waitForRuntimePicker(empty.lastFrame);
  });

  test("selecting an encoded qualifier opens complete endpoint JSON with exact selectors", async () => {
    const qualifier = "prod/blue one";
    const core = new TestCoreClient();
    core.runtime.setListEndpointsResponse({
      runtimeEndpoints: [endpoint({ name: qualifier, id: qualifier })],
    });
    core.runtime.setGetEndpointResponse(getEndpointResponse({ name: qualifier, id: qualifier }));
    const r = renderScreen("/agentcore/runtime/endpoint/list/runtime-123", { core });

    await waitForText(r.lastFrame, qualifier);
    await r.press("return");
    await waitForText(
      r.lastFrame,
      `agentcore → runtime → endpoint → get → runtime-123 → ${qualifier}`,
    );
    await waitForText(r.lastFrame, '"targetVersion"');
    await waitFor(() =>
      core.runtime.calls.some(
        (call) =>
          call.method === "getRuntimeEndpoint" &&
          call.args[0] === "runtime-123" &&
          call.args[1] === qualifier,
      ),
    );
  });

  test("uses a structural parent for the Runtime picker and history below it", async () => {
    const parentCore = new TestCoreClient();
    parentCore.runtime.setListResponse({
      agentRuntimes: [runtime()],
    });
    const parent = renderScreen("/agentcore/runtime/endpoint/list", {
      core: parentCore,
    });
    await waitForText(parent.lastFrame, "checkout");
    await parent.press("escape");
    await waitForText(
      parent.lastFrame,
      "agentcore → runtime → endpoint → inspect AgentCore Runtime endpoints",
    );
    parent.unmount();

    const listCore = new TestCoreClient();
    listCore.runtime.setListResponse({
      agentRuntimes: [runtime()],
    });
    listCore.runtime.setListEndpointsResponse({
      runtimeEndpoints: [endpoint()],
    });
    listCore.runtime.setGetEndpointResponse(getEndpointResponse());
    const list = renderScreen("/agentcore/runtime/endpoint/list", { core: listCore });
    await waitForText(list.lastFrame, "checkout");
    await list.press("return");
    await waitForText(list.lastFrame, "prod");
    await list.press("escape");
    await waitForRuntimePicker(list.lastFrame);

    await list.press("return");
    await waitForText(list.lastFrame, "prod");
    await list.press("return");
    await waitForText(list.lastFrame, '"agentRuntimeEndpointArn"');
    await list.press("escape");
    await waitForText(list.lastFrame, "agentcore → runtime → endpoint → list → runtime-123");
  });

  test("bare endpoint get redirects to parent selection", async () => {
    const core = new TestCoreClient();
    core.runtime.setListResponse({
      agentRuntimes: [runtime({ agentRuntimeName: "redirect-parent" })],
    });
    const r = renderScreen("/agentcore/runtime/endpoint/get", { core });

    await waitForText(r.lastFrame, "redirect-parent");
    expect(core.runtime.calls.some((call) => call.method === "listRuntimes")).toBe(true);
  });
});
