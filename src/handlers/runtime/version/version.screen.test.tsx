import { afterEach, describe, expect, test } from "bun:test";
import type {
  AgentRuntime,
  GetAgentRuntimeResponse,
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

function getVersionResponse(
  overrides: Partial<GetAgentRuntimeResponse> = {},
): GetAgentRuntimeResponse {
  return {
    agentRuntimeArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/runtime-123",
    agentRuntimeName: "checkout",
    agentRuntimeId: "runtime-123",
    agentRuntimeVersion: "3",
    createdAt: new Date("2026-07-19T01:02:03.000Z"),
    lastUpdatedAt: new Date("2026-07-20T12:34:56.000Z"),
    roleArn: "arn:aws:iam::123456789012:role/runtime-role",
    networkConfiguration: { networkMode: "PUBLIC" },
    status: "READY",
    lifecycleConfiguration: {
      idleRuntimeSessionTimeout: 900,
      maxLifetime: 28_800,
    },
    description: "Checkout Runtime version",
    metadataConfiguration: { requireMMDSV2: true },
    ...overrides,
  };
}

async function waitForRuntimePicker(lastFrame: () => string | undefined): Promise<void> {
  await waitFor(() => {
    const frame = lastFrame() ?? "";
    return (
      frame.includes("agentcore → runtime → version → list") &&
      !frame.includes("agentcore → runtime → version → list → runtime-123") &&
      frame.includes("checkout")
    );
  });
}

describe("Runtime version flow", () => {
  test("uses the Runtime picker to scope an unscoped version list", async () => {
    const runtimeId = "runtime/blue one";
    const core = new TestCoreClient();
    core.runtime.setListResponse({
      agentRuntimes: [runtime({ agentRuntimeId: runtimeId, agentRuntimeName: "pick-runtime" })],
    });
    core.runtime.setListVersionsResponse({
      agentRuntimes: [runtime({ agentRuntimeId: runtimeId, agentRuntimeVersion: "9" })],
    });
    const r = renderScreen("/agentcore/runtime/version/list", { core });

    await waitForText(r.lastFrame, "pick-runtime");
    await r.press("return");
    await waitForText(r.lastFrame, "agentcore → runtime → version → list → runtime/blue one");
    await waitForText(r.lastFrame, "9");
    expect(
      core.runtime.calls.some(
        (call) => call.method === "listRuntimeVersions" && call.args[0] === runtimeId,
      ),
    ).toBe(true);
  });

  test("skips parent selection when the Runtime ID is already scoped", async () => {
    const core = new TestCoreClient();
    core.runtime.setListVersionsResponse({
      agentRuntimes: [runtime({ agentRuntimeVersion: "8" })],
    });
    const r = renderScreen("/agentcore/runtime/version/list/runtime-123", { core });

    await waitForText(r.lastFrame, "8");
    expect(core.runtime.calls.some((call) => call.method === "listRuntimes")).toBe(false);
    expect(
      core.runtime.calls.some(
        (call) => call.method === "listRuntimeVersions" && call.args[0] === "runtime-123",
      ),
    ).toBe(true);
  });

  test("calls listRuntimeVersions with exact scope, page size, and options", async () => {
    const core = new TestCoreClient();
    core.runtime.setListVersionsResponse({
      agentRuntimes: [runtime()],
    });
    renderScreen("/agentcore/runtime/version/list/runtime-123", { core });

    await waitFor(() =>
      core.runtime.calls.some(
        (call) => call.method === "listRuntimeVersions" && call.args[2] === 32,
      ),
    );
    expect(core.runtime.calls.filter((call) => call.method === "listRuntimeVersions")).toEqual([
      {
        method: "listRuntimeVersions",
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

  test("renders numeric versions newest first with only version status and update time", async () => {
    const core = new TestCoreClient();
    core.runtime.setListVersionsResponse({
      agentRuntimes: [
        runtime({
          agentRuntimeId: "hidden-id",
          agentRuntimeName: "hidden-name",
          agentRuntimeVersion: "2",
          status: "UPDATE_FAILED",
          lastUpdatedAt: new Date("2026-07-18T02:00:00.000Z"),
        }),
        runtime({
          agentRuntimeId: "hidden-id",
          agentRuntimeName: "hidden-name",
          agentRuntimeVersion: "10",
          status: "READY",
          lastUpdatedAt: new Date("2026-07-20T10:00:00.000Z"),
        }),
      ],
    });
    const r = renderScreen("/agentcore/runtime/version/list/runtime-123", { core });

    await waitForText(r.lastFrame, "UPDATE_FAILED");
    const frame = r.lastFrame()!;
    expect(frame).toContain("version");
    expect(frame).toContain("status");
    expect(frame).toContain("lastUpdatedAt");
    const lines = frame.split("\n");
    const versionTen = lines.findIndex((line) => line.includes("10") && line.includes("READY"));
    const versionTwo = lines.findIndex(
      (line) => line.includes("2") && line.includes("UPDATE_FAILED"),
    );
    expect(versionTen).toBeGreaterThanOrEqual(0);
    expect(versionTwo).toBeGreaterThanOrEqual(0);
    expect(versionTen).toBeLessThan(versionTwo);
    expect(frame).not.toContain("hidden-id");
    expect(frame).not.toContain("hidden-name");
  });

  test("keeps version visible without wrapping lower-priority columns when narrow", async () => {
    const core = new TestCoreClient();
    core.runtime.setListVersionsResponse({
      agentRuntimes: [
        runtime({
          agentRuntimeVersion: "123",
          status: "UPDATE_FAILED",
          lastUpdatedAt: new Date("2026-07-18T02:00:00.000Z"),
        }),
      ],
    });
    const r = renderScreen("/agentcore/runtime/version/list/runtime-123", { core });

    await r.resize(50);
    await waitForText(r.lastFrame, "123");
    const frame = r.lastFrame()!;
    expect(frame).toContain("version");
    expect(frame).toContain("123");
    expect(frame).not.toContain("status");
    expect(frame).not.toContain("lastUpdatedAt");
    expect(frame).not.toContain("UPDATE_FAILED");
    expect(frame).not.toContain("2026-07-18T02:00:00.000Z");
    expect(Math.max(...frame.split("\n").map((line) => line.length))).toBe(50);
  });

  test("describes an empty later page without claiming the Runtime has no versions", async () => {
    const core = new TestCoreClient();
    core.runtime.setListVersionsResponse({
      agentRuntimes: [runtime({ agentRuntimeVersion: "3" })],
      nextToken: "page-2",
    });
    core.runtime.setListVersionsResponse({ agentRuntimes: [] }, "page-2");
    const r = renderScreen("/agentcore/runtime/version/list/runtime-123", { core });

    await waitForText(r.lastFrame, "page 1 · more →");
    await r.write("l");
    await waitForText(r.lastFrame, "No versions on this page for Runtime runtime-123.");
    expect(r.lastFrame()).not.toContain("No versions found for Runtime runtime-123.");
  });

  test("names the selected Runtime in empty and error states", async () => {
    const empty = renderScreen("/agentcore/runtime/version/list/runtime-123");
    await waitForText(empty.lastFrame, "No versions found for Runtime runtime-123.");
    empty.unmount();

    const core = new TestCoreClient();
    core.runtime.setError(new Error("version access denied"));
    const error = renderScreen("/agentcore/runtime/version/list/runtime-123", { core });
    await waitForText(error.lastFrame, "Error loading versions for Runtime runtime-123");
    expect(error.lastFrame()).toContain("version access denied");
    expect(error.lastFrame()).toContain("[r] retry");
  });

  test("selecting a version opens complete JSON with exact selectors", async () => {
    const core = new TestCoreClient();
    core.runtime.setListVersionsResponse({
      agentRuntimes: [runtime({ agentRuntimeVersion: "9" })],
    });
    core.runtime.setGetVersionResponse({
      $metadata: { requestId: "version-request-metadata" },
      ...getVersionResponse({ agentRuntimeVersion: "9" }),
    } as GetAgentRuntimeResponse);
    const r = renderScreen("/agentcore/runtime/version/list/runtime-123", { core });

    await waitForText(r.lastFrame, "9");
    await r.press("return");
    await waitForText(r.lastFrame, "agentcore → runtime → version → get → runtime-123 → 9");
    await waitForText(r.lastFrame, '"networkConfiguration"');
    expect(r.lastFrame()).not.toContain("$metadata");
    expect(r.lastFrame()).not.toContain("version-request-metadata");
    await waitFor(() =>
      core.runtime.calls.some(
        (call) =>
          call.method === "getRuntimeVersion" &&
          call.args[0] === "runtime-123" &&
          call.args[1] === "9",
      ),
    );
  });

  test("uses a structural parent for the Runtime picker and history below it", async () => {
    const parentCore = new TestCoreClient();
    parentCore.runtime.setListResponse({
      agentRuntimes: [runtime()],
    });
    const parent = renderScreen("/agentcore/runtime/version/list", {
      core: parentCore,
    });
    await waitForText(parent.lastFrame, "checkout");
    await parent.press("escape");
    await waitForText(
      parent.lastFrame,
      "agentcore → runtime → version → inspect AgentCore Runtime versions",
    );
    parent.unmount();

    const listCore = new TestCoreClient();
    listCore.runtime.setListResponse({
      agentRuntimes: [runtime()],
    });
    listCore.runtime.setListVersionsResponse({
      agentRuntimes: [runtime()],
    });
    listCore.runtime.setGetVersionResponse(getVersionResponse());
    const list = renderScreen("/agentcore/runtime/version/list", { core: listCore });
    await waitForText(list.lastFrame, "checkout");
    await list.press("return");
    await waitForText(list.lastFrame, "agentcore → runtime → version → list → runtime-123");
    await waitForText(list.lastFrame, "3");
    await list.press("escape");
    await waitForRuntimePicker(list.lastFrame);
    await waitForText(list.lastFrame, "[enter] select");

    await list.press("return");
    await waitForText(list.lastFrame, "agentcore → runtime → version → list → runtime-123");
    await waitForText(list.lastFrame, "3");
    await waitForText(list.lastFrame, "[enter] select");
    await list.press("return");
    await waitForText(list.lastFrame, '"agentRuntimeVersion"');
    await list.press("escape");
    await waitForText(list.lastFrame, "agentcore → runtime → version → list → runtime-123");
  });

  test("bare version get redirects to parent selection", async () => {
    const core = new TestCoreClient();
    core.runtime.setListResponse({
      agentRuntimes: [runtime({ agentRuntimeName: "redirect-parent" })],
    });
    const r = renderScreen("/agentcore/runtime/version/get", { core });

    await waitForText(r.lastFrame, "redirect-parent");
    expect(core.runtime.calls.some((call) => call.method === "listRuntimes")).toBe(true);
  });
});
