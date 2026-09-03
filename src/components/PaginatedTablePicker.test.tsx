import { afterEach, describe, expect, test } from "bun:test";
import type {
  AgentRuntime,
  HarnessSummary,
  ListHarnessesResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { QueryClient } from "@tanstack/react-query";
import stringWidth from "string-width";
import { cleanupScreens, renderScreen, TestCoreClient, waitFor, waitForText } from "../testing";

afterEach(cleanupScreens);

function harness(overrides: Partial<HarnessSummary> = {}): HarnessSummary {
  return {
    harnessId: "MyHarness-abc123",
    harnessName: "MyHarness",
    arn: "arn:aws:bedrock-agentcore:us-east-1:123:harness/MyHarness-abc123",
    createdAt: new Date("2026-04-22T21:53:06.235Z"),
    updatedAt: new Date("2026-04-22T21:53:27.062Z"),
    harnessVersion: "1",
    status: "READY",
    ...overrides,
  };
}

function coreWith(harnesses: HarnessSummary[]): TestCoreClient {
  const core = new TestCoreClient();
  core.harness.setListResponse({ harnesses });
  return core;
}

function runtime(overrides: Partial<AgentRuntime> = {}): AgentRuntime {
  return {
    agentRuntimeArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/orders-AbCdEf1234",
    agentRuntimeId: "orders-AbCdEf1234",
    agentRuntimeVersion: "99999",
    agentRuntimeName: "orders-runtime-with-a-long-name",
    description: "Orders Runtime",
    lastUpdatedAt: new Date("2026-07-19T01:02:03.000Z"),
    status: "CREATE_FAILED",
    ...overrides,
  };
}

function getResponse(summary: HarnessSummary) {
  return { harness: summary } as Parameters<TestCoreClient["harness"]["setGetResponse"]>[0];
}

describe("paginated table picker contract", () => {
  test("retries a failed query", async () => {
    const core = new TestCoreClient();
    core.harness.setError(new Error("access denied"));
    const r = renderScreen("/agentcore/harness/list", { core });

    await waitForText(r.lastFrame, "access denied");
    expect(r.lastFrame()).toContain("[r] retry");

    core.harness.setError(undefined);
    core.harness.setListResponse({
      harnesses: [harness({ harnessName: "recovered" })],
    });
    await r.write("r");
    await waitForText(r.lastFrame, "recovered");
  });

  test("returns to the previous page after a later-page query fails", async () => {
    const core = new TestCoreClient();
    core.harness.setListResponse({
      harnesses: [harness({ harnessName: "page-one" })],
      nextToken: "t2",
    });
    const listHarnesses = core.harness.listHarnesses.bind(core.harness);
    core.harness.listHarnesses = async (...args) => {
      if (args[0] === "t2") throw new Error("page unavailable");
      return listHarnesses(...args);
    };
    const r = renderScreen("/agentcore/harness/list", { core });

    await waitForText(r.lastFrame, "page 1 · more →");
    await r.write("l");
    await waitForText(r.lastFrame, "page unavailable");
    expect(r.lastFrame()).toContain("[←/h] previous page");

    await r.write("h");
    await waitForText(r.lastFrame, "page-one");
    expect(core.harness.calls.at(-1)?.args[0]).toBeUndefined();
  });

  test("keeps Escape active while loading", async () => {
    const core = new TestCoreClient();
    const pending = Promise.withResolvers<ListHarnessesResponse>();
    core.harness.listHarnesses = async () => pending.promise;
    const r = renderScreen("/agentcore/harness/list", { core });

    await waitForText(r.lastFrame, "Loading harnesses");
    await r.press("escape");
    await waitForText(r.lastFrame, "manage agentcore harnesses");
  });

  test("keeps Escape active after a query fails", async () => {
    const core = new TestCoreClient();
    core.harness.setError(new Error("access denied"));
    const r = renderScreen("/agentcore/harness/list", { core });

    await waitForText(r.lastFrame, "access denied");
    await r.press("escape");
    await waitForText(r.lastFrame, "manage agentcore harnesses");
  });

  test("distinguishes first-page and later-page empty states", async () => {
    const firstPage = renderScreen("/agentcore/harness/list");
    await waitForText(firstPage.lastFrame, "No harnesses found.");
    expect(firstPage.lastFrame()).not.toContain("page 1");
    await firstPage.press("escape");
    await waitForText(firstPage.lastFrame, "manage agentcore harnesses");
    firstPage.unmount();

    const core = new TestCoreClient();
    core.harness.setListResponse({
      harnesses: [harness({ harnessName: "page-one" })],
      nextToken: "t2",
    });
    core.harness.setListResponse({ harnesses: [] }, "t2");
    const laterPage = renderScreen("/agentcore/harness/list", { core });

    await waitForText(laterPage.lastFrame, "page 1 · more →");
    await laterPage.write("l");
    await waitForText(laterPage.lastFrame, "No harnesses on this page.");
    expect(laterPage.lastFrame()).toContain("page 2");
    expect(laterPage.lastFrame()).not.toContain("No harnesses found.");
  });

  test("pages forward and backward using token history", async () => {
    const core = new TestCoreClient();
    const first = harness({ harnessName: "page-one-first", harnessId: "page-one-first" });
    core.harness.setListResponse({
      harnesses: [first, harness({ harnessName: "page-one-second", harnessId: "page-one-second" })],
      nextToken: "t2",
    });
    core.harness.setListResponse(
      {
        harnesses: [
          harness({ harnessName: "page-two-first", harnessId: "page-two-first" }),
          harness({ harnessName: "page-two-second", harnessId: "page-two-second" }),
        ],
      },
      "t2",
    );
    core.harness.setGetResponse(getResponse(first));
    const r = renderScreen("/agentcore/harness/list", { core });

    await waitForText(r.lastFrame, "page 1 · more →");
    expect(r.lastFrame()).toContain("[←→/hl] page");
    expect(core.harness.calls.filter((call) => call.method === "listHarnesses")).toEqual([
      {
        method: "listHarnesses",
        args: [undefined, 33, { region: "us-east-1", endpointUrl: undefined }],
      },
    ]);
    await r.press("down");
    await waitForText(r.lastFrame, "❯ page-one-second");
    await r.write("l");
    await waitForText(r.lastFrame, "❯ page-two-first");
    expect(core.harness.calls.at(-1)).toEqual({
      method: "listHarnesses",
      args: ["t2", 33, { region: "us-east-1", endpointUrl: undefined }],
    });

    await r.press("down");
    await waitForText(r.lastFrame, "❯ page-two-second");
    await r.write("h");
    await waitForText(r.lastFrame, "❯ page-one-first");
    expect(r.lastFrame()).toContain("page 1");
    await r.press("return");
    await waitForText(r.lastFrame, "agentcore → harness → get → page-one-first");
    expect(
      core.harness.calls.some(
        (call) => call.method === "getHarness" && call.args[0] === "page-one-second",
      ),
    ).toBe(false);
  });

  test("retains rows and disables selection and paging during a transition", async () => {
    const core = new TestCoreClient();
    core.harness.setListResponse({
      harnesses: [harness({ harnessName: "stable-page-one", harnessId: "stable-1" })],
      nextToken: "t2",
    });
    core.harness.setListResponse(
      { harnesses: [harness({ harnessName: "settled-page-two", harnessId: "settled-2" })] },
      "t2",
    );
    const nextPage = Promise.withResolvers<void>();
    const previousPage = Promise.withResolvers<void>();
    let holdFirstPage = false;
    const listHarnesses = core.harness.listHarnesses.bind(core.harness);
    core.harness.listHarnesses = async (...args) => {
      const response = await listHarnesses(...args);
      if (args[0] === "t2") await nextPage.promise;
      if (args[0] === undefined && holdFirstPage) await previousPage.promise;
      return response;
    };
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity, staleTime: 0 },
      },
    });
    const r = renderScreen("/agentcore/harness/list", { core, queryClient });

    await waitForText(r.lastFrame, "page 1 · more →");
    await r.write("l");
    await waitForText(r.lastFrame, "loading page 2…");
    expect(r.lastFrame()).toContain("stable-page-one");

    const callsDuringTransition = core.harness.calls.length;
    await r.press("return");
    await r.write("l");
    await r.write("h");
    expect(core.harness.calls).toHaveLength(callsDuringTransition);
    expect(core.harness.calls.some((call) => call.method === "getHarness")).toBe(false);

    nextPage.resolve();
    await waitForText(r.lastFrame, "settled-page-two");

    holdFirstPage = true;
    await r.write("h");
    await waitForText(r.lastFrame, "loading page 1…");
    expect(r.lastFrame()).toContain("stable-page-one");

    const callsDuringRefetch = core.harness.calls.length;
    await r.press("return");
    await r.write("l");
    expect(core.harness.calls).toHaveLength(callsDuringRefetch);
    expect(core.harness.calls.some((call) => call.method === "getHarness")).toBe(false);

    await r.press("escape");
    await waitForText(r.lastFrame, "manage agentcore harnesses");
    previousPage.resolve();
  });

  test("resizing resets pagination and selection", async () => {
    const first = harness({ harnessName: "page-one-first", harnessId: "page-one-first" });
    const core = new TestCoreClient();
    core.harness.setListResponse({
      harnesses: [first, harness({ harnessName: "page-one-second", harnessId: "page-one-second" })],
      nextToken: "t2",
    });
    core.harness.setListResponse(
      {
        harnesses: [
          harness({ harnessName: "page-two-first", harnessId: "page-two-first" }),
          harness({ harnessName: "page-two-second", harnessId: "page-two-second" }),
        ],
      },
      "t2",
    );
    core.harness.setGetResponse(getResponse(first));
    const r = renderScreen("/agentcore/harness/list", { core });

    await waitForText(r.lastFrame, "page 1 · more →");
    await r.write("l");
    await waitForText(r.lastFrame, "page-two-second");
    await r.press("down");
    await waitForText(r.lastFrame, "❯ page-two-second");

    await r.resize(100, 20);
    await waitForText(r.lastFrame, "page-one-first");
    await r.press("return");
    await waitForText(r.lastFrame, "agentcore → harness → get → page-one-first");
    expect(
      core.harness.calls.some(
        (call) => call.method === "getHarness" && call.args[0] === "page-one-second",
      ),
    ).toBe(false);
  });

  test("pasted filter input does not page and resets selection to its first match", async () => {
    const alpha = harness({ harnessName: "alpha", harnessId: "alpha-1" });
    const beta = harness({ harnessName: "beta", harnessId: "beta-2" });
    const core = coreWith([alpha, beta]);
    core.harness.setListResponse({ harnesses: [alpha, beta], nextToken: "t2" });
    core.harness.setGetResponse(getResponse(alpha));
    const r = renderScreen("/agentcore/harness/list", { core });

    await waitForText(r.lastFrame, "beta");
    await r.press("down");
    await r.write("/");
    await r.write("missing");
    await waitForText(r.lastFrame, "/ Filter: missing");
    await r.press("escape");
    await r.write("/");
    await r.write("alpha");
    await waitForText(r.lastFrame, "/ Filter: alpha");
    expect(
      core.harness.calls.some((call) => call.method === "listHarnesses" && call.args[0] === "t2"),
    ).toBe(false);

    await r.press("return");
    await r.press("return");
    await waitFor(() =>
      core.harness.calls.some((call) => call.method === "getHarness" && call.args[0] === "alpha-1"),
    );
    expect(r.lastFrame()).toContain("agentcore → harness → get → alpha-1");
  });

  test("moves focus from the Runtime filter into its matching rows", async () => {
    const core = new TestCoreClient();
    core.runtime.setListResponse({
      agentRuntimes: [
        runtime({
          agentRuntimeId: "orders-alpha",
          agentRuntimeName: "orders-alpha",
        }),
        runtime({
          agentRuntimeId: "orders-beta",
          agentRuntimeName: "orders-beta",
        }),
      ],
    });
    const r = renderScreen("/agentcore/runtime/list", { core });

    await waitForText(r.lastFrame, "orders-beta");
    await r.write("/");
    await r.write("orders");
    await waitForText(r.lastFrame, "/ Filter: orders");
    expect(r.lastFrame()).not.toContain("❯ orders-alpha");

    await r.press("down");
    await waitForText(r.lastFrame, "❯ orders-alpha");
    expect(r.lastFrame()).not.toContain("/ Filter: orders█");

    await r.press("up");
    await waitForText(r.lastFrame, "/ Filter: orders█");
    expect(r.lastFrame()).not.toContain("❯ orders-alpha");

    await r.press("down");
    await waitForText(r.lastFrame, "❯ orders-alpha");
    await r.press("down");
    await waitForText(r.lastFrame, "❯ orders-beta");
    await r.press("return");

    await waitFor(() =>
      core.runtime.calls.some(
        (call) => call.method === "getRuntime" && call.args[0] === "orders-beta",
      ),
    );
    expect(
      core.runtime.calls.some(
        (call) => call.method === "getRuntime" && call.args[0] === "orders-alpha",
      ),
    ).toBe(false);
  });

  test("restores server page navigation after moving focus out of the filter", async () => {
    const core = new TestCoreClient();
    core.runtime.setListResponse({
      agentRuntimes: [
        runtime({
          agentRuntimeId: "page-one",
          agentRuntimeName: "matching-page-one",
        }),
      ],
      nextToken: "t2",
    });
    core.runtime.setListResponse(
      {
        agentRuntimes: [
          runtime({
            agentRuntimeId: "page-two",
            agentRuntimeName: "matching-page-two",
          }),
        ],
      },
      "t2",
    );
    const r = renderScreen("/agentcore/runtime/list", { core });

    await waitForText(r.lastFrame, "matching-page-one");
    await r.write("/");
    await r.write("matching");
    await waitForText(r.lastFrame, "/ Filter: matching█");
    await r.press("down");
    await waitForText(r.lastFrame, "❯ matching-page-one");
    await r.press("right");
    await waitForText(r.lastFrame, "❯ matching-page-two");

    expect(r.lastFrame()).toContain("/ Filter: matching");
    expect(r.lastFrame()).not.toContain("/ Filter: matching█");
  });

  test("fills the content area before and during a long filter", async () => {
    const longFilter = `${"filter-prefix-".repeat(8)}visible-suffix`;
    const core = new TestCoreClient();
    core.harness.setListResponse({
      harnesses: Array.from({ length: 33 }, (_, index) =>
        harness({
          harnessId: `harness-${index}`,
          harnessName: `${longFilter}-${String(index).padStart(2, "0")}`,
        }),
      ),
      nextToken: "t2",
    });
    const r = renderScreen("/agentcore/harness/list", { core });

    await waitForText(r.lastFrame, "page 1 · more →");
    let lines = (r.lastFrame() ?? "").split("\n");
    expect(lines[37]).toContain("page 1 · more →");
    expect(lines[38]).toMatch(/^─+$/);

    await r.write("/");
    await r.write(longFilter);
    await waitForText(r.lastFrame, "visible-suffix");
    lines = (r.lastFrame() ?? "").split("\n");
    expect(lines[2]).toContain("name");
    expect(lines[3]).toContain("/ Filter: …");
    expect(lines[3]).toContain("visible-suffix█");
    expect(stringWidth(lines[3]!)).toBeLessThanOrEqual(100);
    expect(lines[37]).toContain("page 1 · more →");
    expect(lines[38]).toMatch(/^─+$/);
  });

  test("keeps pagination and footer hints below every row at narrow widths", async () => {
    const core = new TestCoreClient();
    core.runtime.setListResponse({
      agentRuntimes: Array.from({ length: 17 }, (_, index) => {
        const suffix = String(index).padStart(10, "0");
        return runtime({
          agentRuntimeId: `runtime-${suffix}`,
          agentRuntimeName: `runtime-${index}`,
        });
      }),
      nextToken: "t2",
    });
    const r = renderScreen("/agentcore/runtime/list", { core });

    await r.resize(60, 24);
    await waitFor(() => {
      const frame = r.lastFrame() ?? "";
      return frame.includes("0000000016") && !frame.includes("loading page 1…");
    });
    const lines = (r.lastFrame() ?? "").split("\n");

    expect(lines).toHaveLength(24);
    expect(lines[20]).toContain("0000000016");
    expect(lines[21]).toContain("page 1 · more →");
    expect(lines[22]).toMatch(/^─{60}$/);
    expect(lines[23]).toContain("[esc] back");
    expect(stringWidth(lines[23]!)).toBeLessThanOrEqual(60);
  });

  test("keeps rows aligned and single-line while resizing the Runtime table", async () => {
    const core = new TestCoreClient();
    const suffixes = ["AbCdEf1234", "BcDeFg2345", "CdEfGh3456"];
    core.runtime.setListResponse({
      agentRuntimes: suffixes.map((suffix, index) =>
        runtime({
          agentRuntimeId: `runtime_${index}-${suffix}`,
          agentRuntimeName: `runtime_${index}_with_a_name_that_needs_truncation`,
        }),
      ),
    });
    const r = renderScreen("/agentcore/runtime/list", { core });

    await waitForText(r.lastFrame, suffixes[0]!);
    for (const width of [100, 80, 60]) {
      if (width !== 100) await r.resize(width);
      const lines = (r.lastFrame() ?? "").split("\n");
      const headerIndex = lines.findIndex((line) => line.includes("id suffix"));
      const rowLines = suffixes.map((suffix) => lines.find((line) => line.includes(suffix)));

      expect(headerIndex).toBeGreaterThanOrEqual(0);
      expect(stringWidth(lines[headerIndex + 1]!)).toBe(width);
      expect(rowLines.every((line) => line !== undefined)).toBe(true);
      expect(new Set(rowLines.map((line) => lines.indexOf(line!))).size).toBe(suffixes.length);
      expect(rowLines.every((line) => stringWidth(line!) <= width)).toBe(true);
      expect(rowLines.every((line) => /[A-Za-z0-9]{10}\s+\d/.test(line!))).toBe(true);
    }
  });

  test("filters against rendered timestamps and raw identifiers", async () => {
    const core = new TestCoreClient();
    core.runtime.setListResponse({ agentRuntimes: [runtime()] });
    const r = renderScreen("/agentcore/runtime/list", { core });

    await waitForText(r.lastFrame, "AbCdEf1234");
    await r.write("/");
    await r.write("2026-07-19 01:02");
    await waitForText(r.lastFrame, "/ Filter: 2026-07-19 01:02");

    expect(r.lastFrame()).toContain("AbCdEf1234");
    expect(r.lastFrame()).not.toContain("No Runtimes found in this Region.");

    await r.press("escape");
    await r.write("/");
    await r.write("orders-AbCdEf1234");
    await waitForText(r.lastFrame, "/ Filter: orders-AbCdEf1234");

    expect(r.lastFrame()).toContain("AbCdEf1234");
  });
});
