import { afterEach, describe, expect, test } from "bun:test";
import type {
  AgentRuntime,
  GetAgentRuntimeResponse,
  ListAgentRuntimesResponse,
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

function frameSize(frame: string): { columns: number; rows: number } {
  const lines = frame.split("\n");
  return {
    columns: Math.max(...lines.map((line) => line.length)),
    rows: lines.length,
  };
}

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

async function waitForRuntimeMenu(lastFrame: () => string | undefined): Promise<void> {
  await waitFor(() =>
    (lastFrame() ?? "").includes("agentcore → runtime → inspect AgentCore Runtimes"),
  );
}

describe("runtime test client", () => {
  test("configures list responses and records calls", async () => {
    const core = new TestCoreClient();
    core.runtime.setListResponse({ agentRuntimes: [], nextToken: "page-2" });

    await core.runtime.listRuntimes(undefined, 20, { region: "us-east-1" });

    expect(core.runtime.calls).toEqual([
      {
        method: "listRuntimes",
        args: [undefined, 20, { region: "us-east-1" }],
      },
    ]);
  });

  test("uses exact initial, explicit, and default resize dimensions", async () => {
    const r = renderScreen("/agentcore/runtime");
    await waitForText(r.lastFrame, "agentcore → runtime");
    await tick();

    expect(frameSize(r.lastFrame()!)).toEqual({ columns: 100, rows: 40 });

    await r.resize(60, 12);
    expect(frameSize(r.lastFrame()!)).toEqual({ columns: 60, rows: 12 });

    await r.resize(70);
    expect(frameSize(r.lastFrame()!)).toEqual({ columns: 70, rows: 40 });
  });
});

describe("runtime menus", () => {
  test("renders the Runtime command menu", async () => {
    const r = renderScreen("/agentcore/runtime");
    await waitForText(r.lastFrame, "agentcore → runtime");

    const frame = r.lastFrame()!;
    for (const command of ["get", "list", "version", "endpoint"]) {
      expect(frame).toContain(command);
    }
  });

  test("renders the Runtime version command menu", async () => {
    const r = renderScreen("/agentcore/runtime/version");
    await waitForText(r.lastFrame, "agentcore → runtime → version");

    const frame = r.lastFrame()!;
    for (const command of ["get", "list"]) {
      expect(frame).toContain(command);
    }
  });

  test("renders the Runtime endpoint command menu", async () => {
    const r = renderScreen("/agentcore/runtime/endpoint");
    await waitForText(r.lastFrame, "agentcore → runtime → endpoint");

    const frame = r.lastFrame()!;
    for (const command of ["get", "list"]) {
      expect(frame).toContain(command);
    }
  });
});

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
    expect(frame).toContain("latest");
    expect(frame).toContain("status");
    expect(frame).toContain("lastUpdatedAt");
    expect(frame).toContain("runtime-visible-id");
    expect(frame).toContain("42");
    expect(frame).toContain("CREATE_FAILED");
    expect(frame).toContain("2026-07-19T01:02:03.000Z");
  });

  test("calls listRuntimes with terminal page size and exact Core options", async () => {
    const core = coreWithRuntimes([runtime()]);
    renderScreen("/agentcore/runtime/list", { core });

    await waitFor(() => core.runtime.calls.some((call) => call.args[1] === 32));
    expect(core.runtime.calls.filter((call) => call.method === "listRuntimes")).toEqual([
      {
        method: "listRuntimes",
        args: [
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

  test("shows loading and lets Esc return to the Runtime menu", async () => {
    const core = new TestCoreClient();
    const pending = deferred<ListAgentRuntimesResponse>();
    core.runtime.listRuntimes = async () => pending.promise;
    const r = renderScreen("/agentcore/runtime/list", { core });

    await waitForText(r.lastFrame, "Loading Runtimes…");
    await r.press("escape");
    await waitForRuntimeMenu(r.lastFrame);
    expect(r.lastFrame()).toContain("list AgentCore Runtimes");
  });

  test("shows service errors, retries with r, and lets Esc return to the Runtime menu", async () => {
    const core = new TestCoreClient();
    core.runtime.setError(new Error("runtime access denied"));
    const r = renderScreen("/agentcore/runtime/list", { core });

    await waitForText(r.lastFrame, "runtime access denied");
    expect(r.lastFrame()).toContain("[r] retry");

    core.runtime.setError(undefined);
    core.runtime.setListResponse({
      agentRuntimes: [runtime({ agentRuntimeName: "recovered" })],
    });
    const callsBeforeRetry = core.runtime.calls.filter(
      (call) => call.method === "listRuntimes",
    ).length;
    await r.write("r");
    await waitForText(r.lastFrame, "recovered");
    expect(core.runtime.calls.filter((call) => call.method === "listRuntimes")).toHaveLength(
      callsBeforeRetry + 1,
    );

    core.runtime.setError(new Error("runtime access denied"));
    const errorScreen = renderScreen("/agentcore/runtime/list", { core });
    await waitForText(errorScreen.lastFrame, "runtime access denied");
    await errorScreen.press("escape");
    await waitForRuntimeMenu(errorScreen.lastFrame);
  });

  test("shows the first-page empty state and lets Esc return to the Runtime menu", async () => {
    const r = renderScreen("/agentcore/runtime/list");

    await waitForText(r.lastFrame, "No Runtimes found in this Region.");
    await r.press("escape");
    await waitForRuntimeMenu(r.lastFrame);
    expect(r.lastFrame()).toContain("list AgentCore Runtimes");
  });

  test("pages forward and backward using token history", async () => {
    const core = new TestCoreClient();
    core.runtime.setListResponse({
      agentRuntimes: [runtime({ agentRuntimeName: "page-one" })],
      nextToken: "page-2",
    });
    core.runtime.setListResponse(
      {
        agentRuntimes: [runtime({ agentRuntimeName: "page-two" })],
      },
      "page-2",
    );
    const r = renderScreen("/agentcore/runtime/list", { core });

    await waitForText(r.lastFrame, "page 1 · more →");
    expect(r.lastFrame()).toContain("page-one");

    await r.write("l");
    await waitForText(r.lastFrame, "page-two");
    expect(r.lastFrame()).toContain("page 2");
    expect(core.runtime.calls.at(-1)?.args[0]).toBe("page-2");

    await r.write("h");
    await waitForText(r.lastFrame, "page-one");
    expect(r.lastFrame()).toContain("page 1 · more →");
    expect(core.runtime.calls.at(-1)?.args[0]).toBeUndefined();
  });

  test("resizing resets to page one with the terminal-derived page size", async () => {
    const core = new TestCoreClient();
    core.runtime.setListResponse({
      agentRuntimes: [runtime({ agentRuntimeName: "page-one" })],
      nextToken: "page-2",
    });
    core.runtime.setListResponse(
      {
        agentRuntimes: [runtime({ agentRuntimeName: "page-two" })],
      },
      "page-2",
    );
    const r = renderScreen("/agentcore/runtime/list", { core });

    await waitForText(r.lastFrame, "page 1 · more →");
    await r.write("l");
    await waitForText(r.lastFrame, "page-two");
    const callsBeforeResize = core.runtime.calls.filter(
      (call) => call.method === "listRuntimes",
    ).length;

    await r.resize(100, 20);
    await waitFor(() => {
      const calls = core.runtime.calls.filter((call) => call.method === "listRuntimes");
      return (
        calls.length > callsBeforeResize &&
        calls.at(-1)?.args[0] === undefined &&
        calls.at(-1)?.args[1] === 12
      );
    });
    await waitForText(r.lastFrame, "page-one");
    expect(r.lastFrame()).toContain("page 1 · more →");
    const callsAfterResize = core.runtime.calls
      .filter((call) => call.method === "listRuntimes")
      .slice(callsBeforeResize);
    expect(callsAfterResize.length).toBeGreaterThan(0);
    expect(callsAfterResize.every((call) => call.args[0] === undefined)).toBe(true);
  });

  test("resizing from page two resets selection to the first row on page one", async () => {
    const core = new TestCoreClient();
    core.runtime.setListResponse({
      agentRuntimes: [
        runtime({ agentRuntimeId: "page-one-first", agentRuntimeName: "page-one-first" }),
        runtime({ agentRuntimeId: "page-one-second", agentRuntimeName: "page-one-second" }),
      ],
      nextToken: "page-2",
    });
    core.runtime.setListResponse(
      {
        agentRuntimes: [
          runtime({ agentRuntimeId: "page-two-first", agentRuntimeName: "page-two-first" }),
          runtime({ agentRuntimeId: "page-two-second", agentRuntimeName: "page-two-second" }),
        ],
      },
      "page-2",
    );
    core.runtime.setGetResponse(
      getRuntimeResponse({
        agentRuntimeId: "page-one-first",
        agentRuntimeName: "page-one-first",
      }),
    );
    const r = renderScreen("/agentcore/runtime/list", { core });

    await waitForText(r.lastFrame, "page 1 · more →");
    await r.write("l");
    await waitForText(r.lastFrame, "page-two-second");
    await r.press("down");
    await waitForText(r.lastFrame, "❯ page-two-second");

    await r.resize(100, 20);
    await waitForText(r.lastFrame, "page-one-first");
    await r.press("return");

    await waitForText(r.lastFrame, "agentcore → runtime → get → page-one-first");
    await waitFor(() =>
      core.runtime.calls.some(
        (call) => call.method === "getRuntime" && call.args[0] === "page-one-first",
      ),
    );
    expect(
      core.runtime.calls.some(
        (call) => call.method === "getRuntime" && call.args[0] === "page-one-first",
      ),
    ).toBe(true);
    expect(
      core.runtime.calls.some(
        (call) => call.method === "getRuntime" && call.args[0] === "page-one-second",
      ),
    ).toBe(false);
  });

  test("retains rows and ignores page keys while either page direction is loading", async () => {
    const core = new TestCoreClient();
    core.runtime.setListResponse({
      agentRuntimes: [runtime({ agentRuntimeName: "stable-page-one" })],
      nextToken: "page-2",
    });
    core.runtime.setListResponse(
      {
        agentRuntimes: [runtime({ agentRuntimeName: "settled-page-two" })],
      },
      "page-2",
    );
    const pageTwo = deferred<void>();
    const pageOneAgain = deferred<void>();
    let holdFirstPage = false;
    const listRuntimes = core.runtime.listRuntimes.bind(core.runtime);
    core.runtime.listRuntimes = async (...args) => {
      const result = await listRuntimes(...args);
      if (args[0] === "page-2") await pageTwo.promise;
      if (args[0] === undefined && holdFirstPage) await pageOneAgain.promise;
      return result;
    };
    const r = renderScreen("/agentcore/runtime/list", { core });

    await waitForText(r.lastFrame, "page 1 · more →");
    await r.write("l");
    await waitForText(r.lastFrame, "loading page 2…");
    expect(r.lastFrame()).toContain("stable-page-one");

    const callsDuringTransition = core.runtime.calls.filter(
      (call) => call.method === "listRuntimes",
    ).length;
    await r.write("l");
    await r.write("h");
    expect(core.runtime.calls.filter((call) => call.method === "listRuntimes")).toHaveLength(
      callsDuringTransition,
    );

    pageTwo.resolve();
    await waitForText(r.lastFrame, "settled-page-two");

    holdFirstPage = true;
    await r.write("h");
    await waitForText(r.lastFrame, "loading page 1…");
    expect(r.lastFrame()).toContain("settled-page-two");

    const callsDuringBackTransition = core.runtime.calls.filter(
      (call) => call.method === "listRuntimes",
    ).length;
    await r.write("l");
    expect(core.runtime.calls.filter((call) => call.method === "listRuntimes")).toHaveLength(
      callsDuringBackTransition,
    );

    pageOneAgain.resolve();
    await waitForText(r.lastFrame, "stable-page-one");
  });

  test("disables page keys while a cached page is refetching", async () => {
    const core = new TestCoreClient();
    core.runtime.setListResponse({
      agentRuntimes: [runtime({ agentRuntimeName: "cached-page-one" })],
      nextToken: "page-2",
    });
    core.runtime.setListResponse(
      {
        agentRuntimes: [runtime({ agentRuntimeName: "cached-page-two" })],
      },
      "page-2",
    );
    const pageOneRefetch = deferred<void>();
    let holdFirstPage = false;
    const listRuntimes = core.runtime.listRuntimes.bind(core.runtime);
    core.runtime.listRuntimes = async (...args) => {
      const result = await listRuntimes(...args);
      if (args[0] === undefined && holdFirstPage) await pageOneRefetch.promise;
      return result;
    };
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity, staleTime: 0 },
      },
    });
    const r = renderScreen("/agentcore/runtime/list", { core, queryClient });

    await waitForText(r.lastFrame, "page 1 · more →");
    await r.write("l");
    await waitForText(r.lastFrame, "cached-page-two");

    holdFirstPage = true;
    const callsBeforeBack = core.runtime.calls.length;
    await r.write("h");
    await waitFor(
      () =>
        core.runtime.calls.length > callsBeforeBack &&
        core.runtime.calls.at(-1)?.args[0] === undefined,
    );
    expect(r.lastFrame()).toContain("loading page 1…");
    expect(r.lastFrame()).toContain("cached-page-one");

    const callsDuringRefetch = core.runtime.calls.length;
    await r.write("l");
    expect(core.runtime.calls).toHaveLength(callsDuringRefetch);
    expect(r.lastFrame()).toContain("cached-page-one");

    pageOneRefetch.resolve();
    await waitForText(r.lastFrame, "page 1 · more →");
  });

  test("filters only the loaded page and does not treat h or l as page keys", async () => {
    const core = new TestCoreClient();
    core.runtime.setListResponse({
      agentRuntimes: [runtime({ agentRuntimeName: "orders" })],
      nextToken: "page-2",
    });
    const r = renderScreen("/agentcore/runtime/list", { core });

    await waitForText(r.lastFrame, "page 1 · more →");
    await r.write("/");
    await r.write("l");
    await r.write("h");
    await waitForText(r.lastFrame, "/ Filter this page: lh");
    expect(r.lastFrame()).toContain("No matches on this page");
    expect(core.runtime.calls.some((call) => call.args[0] === "page-2")).toBe(false);
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
    expect(frame).toContain("latest");
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
    await waitForRuntimeMenu(r.lastFrame);
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
    expect(r.lastFrame()).toMatch(/network\s+PUBLIC/);
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
    core.runtime.setGetResponse(
      getRuntimeResponse({
        environmentVariables: Object.fromEntries(
          Array.from({ length: 30 }, (_, index) => [`VARIABLE_${index}`, `value-${index}`]),
        ),
      }),
    );
    const r = renderScreen("/agentcore/runtime/get/runtime-123", { core });

    await waitForText(r.lastFrame, "show the full JSON definition");
    await r.press("return");
    await waitForText(r.lastFrame, "agentcore → runtime → get → runtime-123 → json");
    const frame = r.lastFrame()!;
    expect(frame).toContain('"agentRuntimeId"');
    expect(frame).toContain('"networkConfiguration"');
    expect(frame).toContain('"lifecycleConfiguration"');
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

  test("Esc from the hub returns explicitly to the Runtime picker", async () => {
    const core = new TestCoreClient();
    core.runtime.setGetResponse(getRuntimeResponse());
    const r = renderScreen("/agentcore/runtime/get/runtime-123", { core });

    await waitForText(r.lastFrame, "show the full JSON definition");
    await r.press("escape");
    await waitForText(r.lastFrame, "agentcore → runtime → list");
  });

  test("Esc from Runtime JSON returns explicitly to the Runtime hub", async () => {
    const core = new TestCoreClient();
    core.runtime.setGetResponse(getRuntimeResponse());
    const r = renderScreen("/agentcore/runtime/get/runtime-123/json", { core });

    await waitForText(r.lastFrame, '"agentRuntimeId"');
    await r.press("escape");
    await waitFor(() => {
      const frame = r.lastFrame() ?? "";
      return frame.includes("agentcore → runtime → get → runtime-123") && !frame.includes("→ json");
    });
    await waitForText(r.lastFrame, "show the full JSON definition");
  });

  test("Esc remains active while hub and JSON routes are loading", async () => {
    const hubCore = new TestCoreClient();
    const hubPending = deferred<GetAgentRuntimeResponse>();
    hubCore.runtime.getRuntime = async () => hubPending.promise;
    const hub = renderScreen("/agentcore/runtime/get/runtime-123", { core: hubCore });

    await waitForText(hub.lastFrame, "Loading Runtime…");
    await hub.press("escape");
    await waitForText(hub.lastFrame, "agentcore → runtime → list");
    hub.unmount();

    const jsonCore = new TestCoreClient();
    const jsonPending = deferred<GetAgentRuntimeResponse>();
    jsonCore.runtime.getRuntime = async () => jsonPending.promise;
    const json = renderScreen("/agentcore/runtime/get/runtime-123/json", {
      core: jsonCore,
    });

    await waitForText(json.lastFrame, "Loading Runtime…");
    await json.press("escape");
    await waitFor(() => {
      const frame = json.lastFrame() ?? "";
      return frame.includes("agentcore → runtime → get → runtime-123") && !frame.includes("→ json");
    });
  });

  test("Esc remains active while hub and JSON routes show errors", async () => {
    const hubCore = new TestCoreClient();
    hubCore.runtime.setError(new Error("hub failed"));
    const hub = renderScreen("/agentcore/runtime/get/runtime-123", { core: hubCore });

    await waitForText(hub.lastFrame, "hub failed");
    await hub.press("escape");
    await waitForText(hub.lastFrame, "agentcore → runtime → list");
    hub.unmount();

    const jsonCore = new TestCoreClient();
    jsonCore.runtime.setError(new Error("json failed"));
    const json = renderScreen("/agentcore/runtime/get/runtime-123/json", {
      core: jsonCore,
    });

    await waitForText(json.lastFrame, "json failed");
    await json.press("escape");
    await waitFor(() => {
      const frame = json.lastFrame() ?? "";
      return frame.includes("agentcore → runtime → get → runtime-123") && !frame.includes("→ json");
    });
  });
});
