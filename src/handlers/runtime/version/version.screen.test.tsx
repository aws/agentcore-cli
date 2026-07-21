import { afterEach, describe, expect, test } from "bun:test";
import type {
  AgentRuntime,
  GetAgentRuntimeResponse,
  ListAgentRuntimeVersionsResponse,
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

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((release) => {
    resolve = release;
  });
  return { promise, resolve };
}

async function waitForRuntimeHub(
  lastFrame: () => string | undefined,
  runtimeId = "runtime-123",
): Promise<void> {
  await waitFor(() => {
    const frame = lastFrame() ?? "";
    return frame.includes(`agentcore → runtime → get → ${runtimeId}`) && !frame.includes("→ json");
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
    expect(
      core.runtime.calls.find(
        (call) => call.method === "listRuntimeVersions" && call.args[2] === 32,
      ),
    ).toEqual({
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
    });
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

  test("pages forward and backward using token history", async () => {
    const core = new TestCoreClient();
    core.runtime.setListVersionsResponse({
      agentRuntimes: [runtime({ agentRuntimeVersion: "3" })],
      nextToken: "page-2",
    });
    core.runtime.setListVersionsResponse(
      {
        agentRuntimes: [runtime({ agentRuntimeVersion: "2" })],
      },
      "page-2",
    );
    const r = renderScreen("/agentcore/runtime/version/list/runtime-123", { core });

    await waitForText(r.lastFrame, "page 1 · more →");
    await r.write("l");
    await waitForText(r.lastFrame, "page 2");
    expect(core.runtime.calls.at(-1)?.args[1]).toBe("page-2");

    await r.write("h");
    await waitForText(r.lastFrame, "page 1 · more →");
    expect(core.runtime.calls.at(-1)?.args[1]).toBeUndefined();
  });

  test("retains rows and ignores page keys during a page transition", async () => {
    const core = new TestCoreClient();
    core.runtime.setListVersionsResponse({
      agentRuntimes: [runtime({ agentRuntimeVersion: "11" })],
      nextToken: "page-2",
    });
    core.runtime.setListVersionsResponse(
      {
        agentRuntimes: [runtime({ agentRuntimeVersion: "10" })],
      },
      "page-2",
    );
    const nextPage = deferred<void>();
    const listVersions = core.runtime.listRuntimeVersions.bind(core.runtime);
    core.runtime.listRuntimeVersions = async (...args) => {
      const response = await listVersions(...args);
      if (args[1] === "page-2") await nextPage.promise;
      return response;
    };
    const r = renderScreen("/agentcore/runtime/version/list/runtime-123", { core });

    await waitForText(r.lastFrame, "page 1 · more →");
    await r.write("l");
    await waitForText(r.lastFrame, "loading page 2…");
    expect(r.lastFrame()).toContain("11");

    const callsDuringTransition = core.runtime.calls.length;
    await r.write("l");
    await r.write("h");
    expect(core.runtime.calls).toHaveLength(callsDuringTransition);

    nextPage.resolve();
    await waitForText(r.lastFrame, "10");
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

  test("retries a failed scoped version list", async () => {
    const core = new TestCoreClient();
    core.runtime.setError(new Error("version access denied"));
    const r = renderScreen("/agentcore/runtime/version/list/runtime-123", { core });

    await waitForText(r.lastFrame, "version access denied");
    core.runtime.setError(undefined);
    core.runtime.setListVersionsResponse({
      agentRuntimes: [runtime({ agentRuntimeVersion: "12" })],
    });
    const callsBeforeRetry = core.runtime.calls.length;
    await r.write("r");
    await waitForText(r.lastFrame, "12");
    expect(core.runtime.calls).toHaveLength(callsBeforeRetry + 1);
  });

  test("Esc remains active in loading, error, and empty states", async () => {
    const loadingCore = new TestCoreClient();
    const pending = deferred<ListAgentRuntimeVersionsResponse>();
    loadingCore.runtime.listRuntimeVersions = async () => pending.promise;
    loadingCore.runtime.setGetResponse(getVersionResponse());
    const loading = renderScreen("/agentcore/runtime/version/list/runtime-123", {
      core: loadingCore,
    });
    await waitForText(loading.lastFrame, "Loading versions for Runtime runtime-123…");
    await loading.press("escape");
    await waitForRuntimeHub(loading.lastFrame);
    loading.unmount();

    const errorCore = new TestCoreClient();
    errorCore.runtime.setError(new Error("failed"));
    const error = renderScreen("/agentcore/runtime/version/list/runtime-123", { core: errorCore });
    await waitForText(error.lastFrame, "Error loading versions");
    errorCore.runtime.setError(undefined);
    errorCore.runtime.setGetResponse(getVersionResponse());
    await error.press("escape");
    await waitForRuntimeHub(error.lastFrame);
    error.unmount();

    const emptyCore = new TestCoreClient();
    emptyCore.runtime.setGetResponse(getVersionResponse());
    const empty = renderScreen("/agentcore/runtime/version/list/runtime-123", { core: emptyCore });
    await waitForText(empty.lastFrame, "No versions found");
    await empty.press("escape");
    await waitForRuntimeHub(empty.lastFrame);
  });

  test("selecting a version opens complete JSON with exact selectors", async () => {
    const core = new TestCoreClient();
    core.runtime.setListVersionsResponse({
      agentRuntimes: [runtime({ agentRuntimeVersion: "9" })],
    });
    core.runtime.setGetVersionResponse(getVersionResponse({ agentRuntimeVersion: "9" }));
    const r = renderScreen("/agentcore/runtime/version/list/runtime-123", { core });

    await waitForText(r.lastFrame, "9");
    await r.press("return");
    await waitForText(r.lastFrame, "agentcore → runtime → version → get → runtime-123 → 9");
    await waitForText(r.lastFrame, '"networkConfiguration"');
    await waitFor(() =>
      core.runtime.calls.some(
        (call) =>
          call.method === "getRuntimeVersion" &&
          call.args[0] === "runtime-123" &&
          call.args[1] === "9",
      ),
    );
  });

  test("uses explicit Esc destinations for parent picker, scoped list, and JSON", async () => {
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
    listCore.runtime.setListVersionsResponse({
      agentRuntimes: [runtime()],
    });
    listCore.runtime.setGetResponse(getVersionResponse());
    const list = renderScreen("/agentcore/runtime/version/list/runtime-123", { core: listCore });
    await waitForText(list.lastFrame, "3");
    await list.press("escape");
    await waitForRuntimeHub(list.lastFrame);
    list.unmount();

    const jsonCore = new TestCoreClient();
    jsonCore.runtime.setGetVersionResponse(getVersionResponse());
    jsonCore.runtime.setListVersionsResponse({
      agentRuntimes: [runtime()],
    });
    const json = renderScreen("/agentcore/runtime/version/get/runtime-123/3", { core: jsonCore });
    await waitForText(json.lastFrame, '"agentRuntimeVersion"');
    await json.press("escape");
    await waitForText(json.lastFrame, "agentcore → runtime → version → list → runtime-123");
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
