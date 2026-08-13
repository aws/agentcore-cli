import { afterEach, describe, expect, test } from "bun:test";
import type {
  AgentRuntime,
  AgentRuntimeEndpoint,
  GetAgentRuntimeResponse,
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

const runtimeEndpointUrl = "https://runtime.test";

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

function getRuntimeResponse(): GetAgentRuntimeResponse {
  return {
    agentRuntimeArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/runtime-123",
    agentRuntimeId: "runtime-123",
    agentRuntimeName: "checkout",
    agentRuntimeVersion: "3",
    createdAt: new Date("2026-07-19T01:02:03.000Z"),
    lastUpdatedAt: new Date("2026-07-20T12:34:56.000Z"),
    roleArn: "arn:aws:iam::123456789012:role/runtime-role",
    networkConfiguration: { networkMode: "PUBLIC" },
    lifecycleConfiguration: {
      idleRuntimeSessionTimeout: 900,
      maxLifetime: 28_800,
    },
    status: "READY",
    protocolConfiguration: { serverProtocol: "HTTP" },
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
    renderScreen("/agentcore/runtime/endpoint/list/runtime-123", {
      core,
      endpointUrl: runtimeEndpointUrl,
    });

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
            endpointUrl: runtimeEndpointUrl,
          },
        ],
      },
    ]);
    expect(core.runtime.calls.some((call) => call.method === "listRuntimes")).toBe(false);
  });

  test("renders qualifier, live and target versions, status, and update time", async () => {
    const core = new TestCoreClient();
    core.runtime.setListEndpointsResponse({
      runtimeEndpoints: [
        endpoint({
          name: "production",
          liveVersion: "99999",
          targetVersion: "88888",
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
    expect(frame).toContain("updated UTC");
    expect(frame).toMatch(/target\s+status/);
    expect(frame).toMatch(/production\s+99999\s+88888\s+UPDATE_FAILED/);
    expect(frame).toContain("UPDATE_FAILED");
    expect(frame).toContain("2026-07-18 02:00");
    expect(frame).not.toContain("protocol");
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

  test("selecting an encoded qualifier opens its summary with exact selectors", async () => {
    const qualifier = "prod/blue one";
    const core = new TestCoreClient();
    core.runtime.setListEndpointsResponse({
      runtimeEndpoints: [endpoint({ name: qualifier, id: qualifier })],
    });
    core.runtime.setGetEndpointResponse(getEndpointResponse({ name: qualifier, id: qualifier }));
    const r = renderScreen("/agentcore/runtime/endpoint/list/runtime-123", {
      core,
      endpointUrl: runtimeEndpointUrl,
    });

    await waitForText(r.lastFrame, qualifier);
    await r.press("return");
    await waitForText(
      r.lastFrame,
      `agentcore → runtime → endpoint → get → runtime-123 → ${qualifier}`,
    );
    await waitForText(r.lastFrame, "invoke this Runtime endpoint");
    expect(r.lastFrame()).toMatch(/liveVersion\s+3/);
    expect(r.lastFrame()).toMatch(/targetVersion\s+4/);
    expect(r.lastFrame()).toContain("show the full JSON definition");
    await waitFor(() => core.runtime.calls.some((call) => call.method === "getRuntimeEndpoint"));
    expect(core.runtime.calls.find((call) => call.method === "getRuntimeEndpoint")).toEqual({
      method: "getRuntimeEndpoint",
      args: [
        "runtime-123",
        qualifier,
        {
          region: "us-east-1",
          endpointUrl: runtimeEndpointUrl,
        },
      ],
    });
  });

  test("shows the endpoint failure reason only when the service provides one", async () => {
    const healthyCore = new TestCoreClient();
    healthyCore.runtime.setGetEndpointResponse(getEndpointResponse());
    const healthy = renderScreen("/agentcore/runtime/endpoint/get/runtime-123/prod", {
      core: healthyCore,
    });

    await waitForText(healthy.lastFrame, "invoke this Runtime endpoint");
    expect(healthy.lastFrame()).not.toContain("failureReason");
    healthy.unmount();

    const failedCore = new TestCoreClient();
    failedCore.runtime.setGetEndpointResponse(
      getEndpointResponse({
        status: "UPDATE_FAILED",
        failureReason: "Endpoint failed its health check",
      }),
    );
    const failed = renderScreen("/agentcore/runtime/endpoint/get/runtime-123/prod", {
      core: failedCore,
    });

    await waitForText(failed.lastFrame, "Endpoint failed its health check");
    expect(failed.lastFrame()).toMatch(/failureReason\s+Endpoint failed its health check/);
  });

  test("opens complete endpoint JSON from the detail action and returns to the summary", async () => {
    const core = new TestCoreClient();
    core.runtime.setGetEndpointResponse(getEndpointResponse());
    const r = renderScreen("/agentcore/runtime/endpoint/get/runtime-123/prod", { core });

    await waitForText(r.lastFrame, "invoke this Runtime endpoint");
    await r.press("down");
    await r.press("return");
    await waitForText(
      r.lastFrame,
      "agentcore → runtime → endpoint → get → runtime-123 → prod → json",
    );
    await waitForText(r.lastFrame, '"targetVersion"');

    await r.press("escape");
    await waitFor(() => {
      const frame = r.lastFrame() ?? "";
      return (
        frame.includes("agentcore → runtime → endpoint → get → runtime-123 → prod") &&
        !frame.includes("→ json")
      );
    });
    await waitForText(r.lastFrame, "invoke this Runtime endpoint");
  });

  test("invokes the selected endpoint directly and Esc returns to its summary", async () => {
    const core = new TestCoreClient();
    core.runtime
      .setListEndpointsResponse({ runtimeEndpoints: [endpoint()] })
      .setGetEndpointResponse(getEndpointResponse())
      .setGetResponse(getRuntimeResponse());
    const r = renderScreen("/agentcore/runtime/endpoint/list/runtime-123", { core });

    await waitForText(r.lastFrame, "prod");
    await r.press("return");
    await waitForText(r.lastFrame, "invoke this Runtime endpoint");
    await r.press("return");
    await waitForText(r.lastFrame, "agentcore → runtime → invoke → runtime-123 → prod");
    await waitForText(r.lastFrame, "Enter JSON payload");

    await r.press("escape");
    await waitForText(r.lastFrame, "agentcore → runtime → endpoint → get → runtime-123 → prod");
    await waitForText(r.lastFrame, "invoke this Runtime endpoint");
    await r.press("escape");
    await waitForText(r.lastFrame, "agentcore → runtime → endpoint → list → runtime-123");
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
    await waitForText(list.lastFrame, "invoke this Runtime endpoint");
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
