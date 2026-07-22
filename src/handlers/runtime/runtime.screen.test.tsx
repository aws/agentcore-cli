import { afterEach, describe, expect, test } from "bun:test";
import type {
  AgentRuntime,
  GetAgentRuntimeResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { QueryClient } from "@tanstack/react-query";
import {
  cleanupScreens,
  renderScreen,
  TestCoreClient,
  tick,
  waitFor,
  waitForText,
} from "../../testing";

afterEach(cleanupScreens);

function runtime(overrides: Partial<AgentRuntime> = {}): AgentRuntime {
  return {
    agentRuntimeArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/runtime-1",
    agentRuntimeId: "runtime-1",
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
    protocolConfiguration: { serverProtocol: "HTTP" },
    lifecycleConfiguration: {
      idleRuntimeSessionTimeout: 900,
      maxLifetime: 28_800,
    },
    description: "Checkout Runtime",
    workloadIdentityDetails: {
      workloadIdentityArn:
        "arn:aws:bedrock-agentcore:us-east-1:123456789012:workload-identity/checkout",
    },
    agentRuntimeArtifact: {
      containerConfiguration: {
        containerUri: "123456789012.dkr.ecr.us-east-1.amazonaws.com/checkout:latest",
      },
    },
    metadataConfiguration: { requireMMDSV2: true },
    ...overrides,
  };
}

function coreWithRuntimes(runtimes: AgentRuntime[]): TestCoreClient {
  const core = new TestCoreClient();
  core.runtime.setListResponse({ agentRuntimes: runtimes });
  return core;
}

describe("runtime picker", () => {
  test("renders Runtime identity, latest version, status, and update time when wide", async () => {
    const core = coreWithRuntimes([
      runtime({
        agentRuntimeId: "runtime-visible-id",
        agentRuntimeName: "orders",
        agentRuntimeVersion: "42",
        status: "CREATE_FAILED",
        lastUpdatedAt: new Date("2026-07-19T01:02:03.000Z"),
      }),
    ]);
    const r = renderScreen("/agentcore/runtime/list", { core });

    await r.resize(140);
    await waitForText(r.lastFrame, "orders");
    const frame = r.lastFrame()!;
    expect(frame).toContain("name");
    expect(frame).toContain("id");
    expect(frame).toContain("latestVersion");
    expect(frame).toContain("status");
    expect(frame).toContain("lastUpdatedAt");
    expect(frame).toContain("runtime-visible-id");
    expect(frame).toContain("42");
    expect(frame).toContain("CREATE_FAILED");
    expect(frame).toContain("2026-07-19T01:02:03.000Z");
  });

  test("calls listRuntimes once with exact Core options", async () => {
    const core = coreWithRuntimes([runtime()]);
    renderScreen("/agentcore/runtime/list", { core });

    await waitFor(() => core.runtime.calls.some((call) => call.method === "listRuntimes"));
    expect(core.runtime.calls.filter((call) => call.method === "listRuntimes")).toEqual([
      {
        method: "listRuntimes",
        args: [
          undefined,
          expect.any(Number),
          {
            region: "us-east-1",
            endpointUrl: undefined,
          },
        ],
      },
    ]);
  });

  test("shows the first-page empty state", async () => {
    const r = renderScreen("/agentcore/runtime/list");

    await waitForText(r.lastFrame, "No Runtimes found in this Region.");
  });

  test("describes an empty later page without claiming the Region has no Runtimes", async () => {
    const core = new TestCoreClient();
    core.runtime.setListResponse({
      agentRuntimes: [runtime({ agentRuntimeName: "page-one" })],
      nextToken: "page-2",
    });
    core.runtime.setListResponse({ agentRuntimes: [] }, "page-2");
    const r = renderScreen("/agentcore/runtime/list", { core });

    await waitForText(r.lastFrame, "page 1 · more →");
    await r.write("l");
    await waitForText(r.lastFrame, "No Runtimes on this page.");
    expect(r.lastFrame()).not.toContain("No Runtimes found in this Region.");
  });

  test("keeps name and latest version when narrow", async () => {
    const core = coreWithRuntimes([
      runtime({
        agentRuntimeId: "hidden-runtime-id",
        agentRuntimeName: "visible-name",
        agentRuntimeVersion: "88",
        status: "CREATE_FAILED",
        lastUpdatedAt: new Date("2026-07-18T09:08:07.000Z"),
      }),
    ]);
    const r = renderScreen("/agentcore/runtime/list", { core });

    await r.resize(60);
    await waitForText(r.lastFrame, "visible-name");
    const frame = r.lastFrame()!;
    expect(frame).toContain("name");
    expect(frame).toContain("latestVersion");
    expect(frame).toContain("visible-name");
    expect(frame).toContain("88");
    expect(frame).not.toContain("hidden-runtime-id");
    expect(frame).not.toContain("CREATE_FAILED");
    expect(frame).not.toContain("2026-07-18T09:08:07.000Z");
  });

  test("Esc returns to the Runtime menu from a successful direct entry", async () => {
    const core = coreWithRuntimes([runtime()]);
    const r = renderScreen("/agentcore/runtime/list", { core });

    await waitForText(r.lastFrame, "checkout");
    await r.press("escape");
    await waitForText(r.lastFrame, "agentcore → runtime → inspect AgentCore Runtimes");
    expect(r.lastFrame()).toContain("list AgentCore Runtimes");
  });

  test("bare Runtime get redirects to the picker", async () => {
    const core = coreWithRuntimes([runtime({ agentRuntimeName: "redirected" })]);
    const r = renderScreen("/agentcore/runtime/get", { core });

    await waitForText(r.lastFrame, "redirected");
    expect(core.runtime.calls[0]?.method).toBe("listRuntimes");
  });
});

describe("runtime hub", () => {
  test("fetches the route ID with exact Core options and renders its summary", async () => {
    const core = new TestCoreClient();
    core.runtime.setGetResponse(getRuntimeResponse());
    const r = renderScreen("/agentcore/runtime/get/runtime-123", { core });

    await waitForText(r.lastFrame, "arn:aws:bedrock-agentcore:us-east-1");
    expect(r.lastFrame()).toContain("runtime-123");
    expect(r.lastFrame()).toContain("READY");
    expect(r.lastFrame()).toMatch(/version\s+7/);
    expect(r.lastFrame()).toMatch(/protocol\s+HTTP/);
    expect(r.lastFrame()).toMatch(/network\s+PUBLIC/);
    expect(r.lastFrame()).not.toContain("failureReason");
    await waitFor(() => core.runtime.calls.some((call) => call.method === "getRuntime"));
    expect(core.runtime.calls.find((call) => call.method === "getRuntime")).toEqual({
      method: "getRuntime",
      args: [
        "runtime-123",
        {
          region: "us-east-1",
          endpointUrl: undefined,
        },
      ],
    });
  });

  test("shows the Runtime failure reason only when the service provides one", async () => {
    const healthyCore = new TestCoreClient();
    healthyCore.runtime.setGetResponse(getRuntimeResponse());
    const healthy = renderScreen("/agentcore/runtime/get/runtime-123", { core: healthyCore });

    await waitForText(healthy.lastFrame, "show the full JSON definition");
    expect(healthy.lastFrame()).not.toContain("failureReason");
    healthy.unmount();

    const failedCore = new TestCoreClient();
    failedCore.runtime.setGetResponse(
      getRuntimeResponse({
        status: "CREATE_FAILED",
        failureReason: "Image could not be pulled",
      }),
    );
    const failed = renderScreen("/agentcore/runtime/get/runtime-123", { core: failedCore });

    await waitForText(failed.lastFrame, "Image could not be pulled");
    expect(failed.lastFrame()).toMatch(/failureReason\s+Image could not be pulled/);
  });

  test("renders exactly the read-only detail, versions, and endpoints actions", async () => {
    const core = new TestCoreClient();
    core.runtime.setGetResponse(getRuntimeResponse());
    const r = renderScreen("/agentcore/runtime/get/runtime-123", { core });

    await waitForText(r.lastFrame, "show the full JSON definition");
    const frame = r.lastFrame()!;
    expect(frame).toContain("versions");
    expect(frame).toContain("endpoints");
    for (const excluded of ["invoke", "exec", "update", "create", "delete"]) {
      expect(frame).not.toContain(excluded);
    }
  });

  test("picker selection encodes the ID and opens the matching Runtime hub", async () => {
    const runtimeId = "runtime/blue one";
    const core = coreWithRuntimes([
      runtime({ agentRuntimeId: runtimeId, agentRuntimeName: "encoded-runtime" }),
    ]);
    core.runtime.setGetResponse(
      getRuntimeResponse({
        agentRuntimeId: runtimeId,
        agentRuntimeName: "encoded-runtime",
      }),
    );
    const r = renderScreen("/agentcore/runtime/list", { core });

    await waitForText(r.lastFrame, "encoded-runtime");
    await r.press("return");
    await waitForText(r.lastFrame, `agentcore → runtime → get → ${runtimeId}`);
    await waitFor(() =>
      core.runtime.calls.some((call) => call.method === "getRuntime" && call.args[0] === runtimeId),
    );
  });

  test.each([
    ["versions", 1],
    ["endpoints", 2],
  ] as const)(
    "selecting %s opens its encoded Runtime-scoped route",
    async (action, downPresses) => {
      const runtimeId = "runtime/blue one";
      const core = new TestCoreClient();
      core.runtime.setGetResponse(getRuntimeResponse({ agentRuntimeId: runtimeId }));
      if (action === "versions") {
        core.runtime.setListVersionsResponse({
          agentRuntimes: [runtime({ agentRuntimeId: runtimeId, agentRuntimeVersion: "7" })],
        });
      } else {
        core.runtime.setListEndpointsResponse({
          runtimeEndpoints: [
            {
              name: "prod",
              id: "prod",
              liveVersion: "7",
              agentRuntimeEndpointArn: "arn:endpoint",
              agentRuntimeArn: "arn:runtime",
              status: "READY",
              createdAt: new Date("2026-07-19T01:02:03.000Z"),
              lastUpdatedAt: new Date("2026-07-20T12:34:56.000Z"),
            },
          ],
        });
      }
      const r = renderScreen(`/agentcore/runtime/get/${encodeURIComponent(runtimeId)}`, {
        core,
      });

      await waitForText(r.lastFrame, "show the full JSON definition");
      for (let index = 0; index < downPresses; index += 1) {
        await r.press("down");
      }
      await r.press("return");

      await waitForText(
        r.lastFrame,
        action === "versions"
          ? `agentcore → runtime → version → list → ${runtimeId}`
          : `agentcore → runtime → endpoint → list → ${runtimeId}`,
      );
    },
  );

  test("opens complete Runtime JSON from the detail action and scrolls", async () => {
    const core = new TestCoreClient();
    core.runtime.setGetResponse({
      $metadata: { requestId: "runtime-request-metadata" },
      ...getRuntimeResponse({
        environmentVariables: Object.fromEntries(
          Array.from({ length: 30 }, (_, index) => [`VARIABLE_${index}`, `value-${index}`]),
        ),
      }),
    } as GetAgentRuntimeResponse);
    const r = renderScreen("/agentcore/runtime/get/runtime-123", { core });

    await waitForText(r.lastFrame, "show the full JSON definition");
    await r.press("return");
    await waitForText(r.lastFrame, "agentcore → runtime → get → runtime-123 → json");
    const frame = r.lastFrame()!;
    expect(frame).toContain('"agentRuntimeId"');
    expect(frame).toContain('"networkConfiguration"');
    expect(frame).toContain('"lifecycleConfiguration"');
    expect(frame).not.toContain("$metadata");
    expect(frame).not.toContain("runtime-request-metadata");
    expect(frame).not.toContain('"VARIABLE_29"');
    for (let index = 0; index < 20; index += 1) await r.press("down");
    for (let index = 0; index < 20; index += 1) await r.write("j");
    await waitForText(r.lastFrame, '"VARIABLE_29"');
    expect(r.lastFrame()).not.toContain('"agentRuntimeId"');
    await r.press("up");
    await r.write("k");
    expect(r.lastFrame()).toContain('"VARIABLE_28"');
  });

  test("retries a failed hub query without leaving the route", async () => {
    const core = new TestCoreClient();
    core.runtime.setError(new Error("runtime unavailable"));
    const r = renderScreen("/agentcore/runtime/get/runtime-123", { core });

    await waitForText(r.lastFrame, "runtime unavailable");
    expect(r.lastFrame()).toContain("agentcore → runtime → get → runtime-123");
    expect(r.lastFrame()).toContain("[r] retry");

    core.runtime.setError(undefined);
    core.runtime.setGetResponse(getRuntimeResponse());
    const callsBeforeRetry = core.runtime.calls.length;
    await r.write("r");
    await waitForText(r.lastFrame, "show the full JSON definition");
    expect(core.runtime.calls).toHaveLength(callsBeforeRetry + 1);
  });

  test("does not activate cached hub actions after a background refetch fails", async () => {
    const core = new TestCoreClient();
    core.runtime.setGetResponse(getRuntimeResponse());
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity, staleTime: 0 },
      },
    });
    const r = renderScreen("/agentcore/runtime/get/runtime-123", {
      core,
      queryClient,
    });

    await waitForText(r.lastFrame, "show the full JSON definition");
    core.runtime.setError(new Error("background refresh failed"));
    await queryClient.invalidateQueries({
      queryKey: ["runtime", "us-east-1", "runtime-123"],
    });
    await waitForText(r.lastFrame, "background refresh failed");

    await r.press("return");
    await tick();
    expect(r.lastFrame()).toContain("agentcore → runtime → get → runtime-123");
    expect(r.lastFrame()).not.toContain("→ json");
    expect(r.lastFrame()).toContain("background refresh failed");
  });

  test("retries a failed JSON query without leaving the route", async () => {
    const core = new TestCoreClient();
    core.runtime.setError(new Error("detail unavailable"));
    const r = renderScreen("/agentcore/runtime/get/runtime-123/json", { core });

    await waitForText(r.lastFrame, "detail unavailable");
    expect(r.lastFrame()).toContain("[r] retry");

    core.runtime.setError(undefined);
    core.runtime.setGetResponse(getRuntimeResponse());
    const callsBeforeRetry = core.runtime.calls.length;
    await r.write("r");
    await waitForText(r.lastFrame, '"agentRuntimeId"');
    expect(core.runtime.calls).toHaveLength(callsBeforeRetry + 1);
  });

  test("Esc from the hub returns through history to the Runtime picker", async () => {
    const core = coreWithRuntimes([runtime({ agentRuntimeId: "runtime-123" })]);
    core.runtime.setGetResponse(getRuntimeResponse());
    const r = renderScreen("/agentcore/runtime/list", { core });

    await waitForText(r.lastFrame, "checkout");
    await r.press("return");
    await waitForText(r.lastFrame, "show the full JSON definition");
    await r.press("escape");
    await waitForText(r.lastFrame, "agentcore → runtime → list");
  });

  test("Esc from Runtime JSON returns through history to the Runtime hub", async () => {
    const core = coreWithRuntimes([runtime({ agentRuntimeId: "runtime-123" })]);
    core.runtime.setGetResponse(getRuntimeResponse());
    const r = renderScreen("/agentcore/runtime/list", { core });

    await waitForText(r.lastFrame, "checkout");
    await r.press("return");
    await waitForText(r.lastFrame, "show the full JSON definition");
    await r.press("return");
    await waitForText(r.lastFrame, '"agentRuntimeId"');
    await r.press("escape");
    await waitFor(() => {
      const frame = r.lastFrame() ?? "";
      return frame.includes("agentcore → runtime → get → runtime-123") && !frame.includes("→ json");
    });
    await waitForText(r.lastFrame, "show the full JSON definition");
  });

  test("Esc remains active while the hub is loading", async () => {
    const hubCore = coreWithRuntimes([runtime({ agentRuntimeId: "runtime-123" })]);
    const hubPending = Promise.withResolvers<GetAgentRuntimeResponse>();
    hubCore.runtime.getRuntime = async () => hubPending.promise;
    const hub = renderScreen("/agentcore/runtime/list", { core: hubCore });

    await waitForText(hub.lastFrame, "checkout");
    await hub.press("return");
    await waitForText(hub.lastFrame, "Loading Runtime…");
    await hub.press("escape");
    await waitForText(hub.lastFrame, "agentcore → runtime → list");
  });

  test("Esc remains active while hub and JSON routes show errors", async () => {
    const hubCore = coreWithRuntimes([runtime({ agentRuntimeId: "runtime-123" })]);
    hubCore.runtime.getRuntime = async () => {
      throw new Error("hub failed");
    };
    const hub = renderScreen("/agentcore/runtime/list", { core: hubCore });

    await waitForText(hub.lastFrame, "checkout");
    await hub.press("return");
    await waitForText(hub.lastFrame, "hub failed");
    await hub.press("escape");
    await waitForText(hub.lastFrame, "agentcore → runtime → list");
    hub.unmount();

    const jsonCore = coreWithRuntimes([runtime({ agentRuntimeId: "runtime-123" })]);
    jsonCore.runtime.setGetResponse(getRuntimeResponse());
    const json = renderScreen("/agentcore/runtime/list", { core: jsonCore });

    await waitForText(json.lastFrame, "checkout");
    await json.press("return");
    await waitForText(json.lastFrame, "show the full JSON definition");
    jsonCore.runtime.setError(new Error("json failed"));
    await json.press("return");
    await waitForText(json.lastFrame, "json failed");
    await json.press("escape");
    await waitFor(() => {
      const frame = json.lastFrame() ?? "";
      return frame.includes("agentcore → runtime → get → runtime-123") && !frame.includes("→ json");
    });
  });
});
