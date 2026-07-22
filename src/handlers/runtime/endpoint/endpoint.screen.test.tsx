import { afterEach, describe, expect, test } from "bun:test";
import type {
  AgentRuntime,
  AgentRuntimeEndpoint,
  GetAgentRuntimeEndpointResponse,
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

  test("calls listRuntimeEndpoints once with exact scope and options", async () => {
    const core = new TestCoreClient();
    core.runtime.setListEndpointsResponse({
      runtimeEndpoints: [endpoint()],
    });
    renderScreen("/agentcore/runtime/endpoint/list/runtime-123", { core });

    await waitFor(() => core.runtime.calls.some((call) => call.method === "listRuntimeEndpoints"));
    expect(core.runtime.calls.filter((call) => call.method === "listRuntimeEndpoints")).toEqual([
      {
        method: "listRuntimeEndpoints",
        args: [
          "runtime-123",
          undefined,
          expect.any(Number),
          {
            region: "us-east-1",
            endpointUrl: undefined,
          },
        ],
      },
    ]);
    expect(core.runtime.calls.some((call) => call.method === "listRuntimes")).toBe(false);
  });

  test("renders qualifier, live and target versions, status, and update time when wide", async () => {
    const core = new TestCoreClient();
    core.runtime.setListEndpointsResponse({
      runtimeEndpoints: [
        endpoint({
          name: "production",
          liveVersion: "7",
          targetVersion: "8",
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
    expect(frame).toContain("target");
    expect(frame).toContain("status");
    expect(frame).toContain("lastUpdatedAt");
    expect(frame).toMatch(/target\s+status/);
    expect(frame).toMatch(/production\s+7\s+8\s+UPDATE_FAILED/);
    expect(frame).toContain("UPDATE_FAILED");
    expect(frame).toContain("2026-07-18T02:00:00.000Z");
    expect(frame).not.toContain("protocol");
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
    expect(frame).not.toContain("target");
    expect(frame).not.toContain("status");
    expect(frame).not.toContain("lastUpdatedAt");
    expect(frame).not.toContain("UPDATE_FAILED");
  });

  test("shows the Runtime-scoped empty state", async () => {
    const r = renderScreen("/agentcore/runtime/endpoint/list/runtime-123");

    await waitForText(r.lastFrame, "This Runtime has no endpoints.");
    expect(r.lastFrame()).toContain("runtime-123");
  });

  test("describes an empty later page without claiming the Runtime has no endpoints", async () => {
    const core = new TestCoreClient();
    core.runtime.setListEndpointsResponse({
      runtimeEndpoints: [endpoint({ name: "page-one" })],
      nextToken: "page-2",
    });
    core.runtime.setListEndpointsResponse({ runtimeEndpoints: [] }, "page-2");
    const r = renderScreen("/agentcore/runtime/endpoint/list/runtime-123", { core });

    await waitForText(r.lastFrame, "page 1 · more →");
    await r.write("l");
    await waitForText(r.lastFrame, "No endpoints on this page for Runtime runtime-123.");
    expect(r.lastFrame()).not.toContain("This Runtime has no endpoints.");
  });

  test("names the selected Runtime in the error state", async () => {
    const core = new TestCoreClient();
    core.runtime.setError(new Error("endpoint access denied"));
    const r = renderScreen("/agentcore/runtime/endpoint/list/runtime-123", { core });

    await waitForText(r.lastFrame, "Error loading endpoints for Runtime runtime-123");
    expect(r.lastFrame()).toContain("endpoint access denied");
  });

  test("selecting an encoded qualifier opens complete endpoint JSON with exact selectors", async () => {
    const qualifier = "prod/blue one";
    const core = new TestCoreClient();
    core.runtime.setListEndpointsResponse({
      runtimeEndpoints: [endpoint({ name: qualifier, id: qualifier })],
    });
    core.runtime.setGetEndpointResponse({
      $metadata: { requestId: "endpoint-request-metadata" },
      ...getEndpointResponse({ name: qualifier, id: qualifier }),
    } as GetAgentRuntimeEndpointResponse);
    const r = renderScreen("/agentcore/runtime/endpoint/list/runtime-123", { core });

    await waitForText(r.lastFrame, qualifier);
    await r.press("return");
    await waitForText(
      r.lastFrame,
      `agentcore → runtime → endpoint → get → runtime-123 → ${qualifier}`,
    );
    await waitForText(r.lastFrame, '"targetVersion"');
    expect(r.lastFrame()).not.toContain("$metadata");
    expect(r.lastFrame()).not.toContain("endpoint-request-metadata");
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
