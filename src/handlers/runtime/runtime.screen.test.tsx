import { afterEach, describe, expect, test } from "bun:test";
import type {
  AgentRuntime,
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
    expect(core.runtime.calls.find((call) => call.args[1] === 32)).toEqual({
      method: "listRuntimes",
      args: [
        undefined,
        32,
        {
          region: "us-east-1",
          endpointUrl: undefined,
        },
      ],
    });
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
