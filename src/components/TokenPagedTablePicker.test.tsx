import { afterEach, describe, expect, test } from "bun:test";
import type {
  HarnessSummary,
  ListHarnessesResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { QueryClient } from "@tanstack/react-query";
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

function getResponse(summary: HarnessSummary) {
  return { harness: summary } as Parameters<TestCoreClient["harness"]["setGetResponse"]>[0];
}

function frameSize(frame: string): { columns: number; rows: number } {
  const lines = frame.split("\n");
  return {
    columns: Math.max(...lines.map((line) => line.length)),
    rows: lines.length,
  };
}

describe("token-paged table picker contract", () => {
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
    core.harness.setListResponse({
      harnesses: [harness({ harnessName: "page-one" })],
      nextToken: "t2",
    });
    core.harness.setListResponse({ harnesses: [harness({ harnessName: "page-two" })] }, "t2");
    const r = renderScreen("/agentcore/harness/list", { core });

    await waitForText(r.lastFrame, "page 1 · more →");
    expect(r.lastFrame()).toContain("[←→/hl] page");
    await r.write("l");
    await waitForText(r.lastFrame, "page-two");
    expect(core.harness.calls.at(-1)).toEqual({
      method: "listHarnesses",
      args: ["t2", 32, { region: "us-east-1", endpointUrl: undefined }],
    });

    await r.write("h");
    await waitForText(r.lastFrame, "page-one");
    expect(r.lastFrame()).toContain("page 1");
    await r.press("escape");
    await waitForText(r.lastFrame, "manage agentcore harnesses");
  });

  test("keeps pagination status and key hints coherent at 50x20", async () => {
    const core = new TestCoreClient();
    core.harness.setListResponse({
      harnesses: Array.from({ length: 12 }, (_, index) =>
        harness({
          harnessId: `narrow-row-${index + 1}`,
          harnessName: `narrow-row-${index + 1}`,
        }),
      ),
      nextToken: "t2",
    });
    const r = renderScreen("/agentcore/harness/list", { core });

    await waitForText(r.lastFrame, "narrow-row-12");
    await r.resize(50, 20);
    await waitForText(r.lastFrame, "page 1 · more →");
    const frame = r.lastFrame()!;
    const lines = frame.split("\n");
    const pageLine = lines.find((line) => line.includes("page 1 · more →"));
    const footerLine = lines.find((line) => line.includes("[↑↓/jk] navigate"));

    expect(frameSize(frame)).toEqual({ columns: 50, rows: 20 });
    expect(pageLine?.trim()).toBe("page 1 · more →");
    expect(pageLine).not.toContain("narrow-row");
    expect(footerLine).toContain("[enter] select");
    expect(footerLine).toContain("[esc] back");
    expect(frame).not.toContain("[←→/hl] page");
    expect(frame).not.toContain("[/] filter");
    expect(frame).not.toContain("[ctl+c] quit");
    expect(footerLine!.indexOf("[↑↓/jk] navigate")).toBeLessThan(
      footerLine!.indexOf("[enter] select"),
    );
    expect(footerLine!.indexOf("[enter] select")).toBeLessThan(footerLine!.indexOf("[esc] back"));
    expect(
      lines.filter((line) => line.includes("[") && line.includes("]")).map((line) => line.trim()),
    ).toEqual([footerLine!.trim()]);
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

  test("filter input does not page and resets selection to its first match", async () => {
    const alpha = harness({ harnessName: "alpha", harnessId: "alpha-1" });
    const beta = harness({ harnessName: "beta", harnessId: "beta-2" });
    const core = coreWith([alpha, beta]);
    core.harness.setListResponse({ harnesses: [alpha, beta], nextToken: "t2" });
    core.harness.setGetResponse(getResponse(alpha));
    const r = renderScreen("/agentcore/harness/list", { core });

    await waitForText(r.lastFrame, "beta");
    await r.press("down");
    await r.write("/");
    for (const character of "alpha") await r.write(character);
    await waitForText(r.lastFrame, "/ Filter this page: alpha");
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
});
