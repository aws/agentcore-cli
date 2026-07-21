import { test, expect, describe, afterEach } from "bun:test";
import type { HarnessSummary } from "@aws-sdk/client-bedrock-agentcore-control";
import {
  renderScreen,
  waitForText,
  waitFor,
  cleanupScreens,
  TestCoreClient,
} from "../../../testing";

afterEach(cleanupScreens);

// Behavior tests for the harness list screen, mounted through the real Root at
// its route. Data comes from a TestCoreClient, so we assert on what the user
// sees for each query state and how selection/back navigation behave.

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

// A HarnessSummary is enough for the detail screen's render (it stringifies
// whatever `harness` field it gets), so reuse it as the get response, widening
// to the response's `harness` type.
function getResponse(summary: HarnessSummary) {
  return { harness: summary } as Parameters<TestCoreClient["harness"]["setGetResponse"]>[0];
}

describe("harness list screen", () => {
  test("renders each harness as a row once loaded", async () => {
    const core = coreWith([
      harness({ harnessName: "alpha", harnessId: "alpha-1" }),
      harness({ harnessName: "beta", harnessId: "beta-2" }),
    ]);
    const r = renderScreen("/agentcore/harness/list", { core });

    await waitForText(r.lastFrame, "alpha");
    const frame = r.lastFrame()!;
    expect(frame).toContain("beta");
    expect(frame).toContain("READY");
    // Column headers are present.
    expect(frame).toContain("name");
    expect(frame).toContain("status");
    r.unmount();
  });

  test("shows a loading indicator before data arrives", async () => {
    // A list response that never resolves keeps the screen pending.
    const core = new TestCoreClient();
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = core.harness.listHarnesses.bind(core.harness);
    core.harness.listHarnesses = async (...args) => {
      await pending;
      return original(...args);
    };

    const r = renderScreen("/agentcore/harness/list", { core });
    await waitForText(r.lastFrame, "Loading harnesses");
    expect(r.lastFrame()).toContain("Loading harnesses");
    release?.();
    r.unmount();
  });

  test("shows the error message when the list call fails", async () => {
    const core = new TestCoreClient();
    core.harness.setError(new Error("access denied"));
    const r = renderScreen("/agentcore/harness/list", { core });

    await waitForText(r.lastFrame, "Error:");
    expect(r.lastFrame()).toContain("access denied");
    r.unmount();
  });

  test("makes one initial list request at the 100x40 page size with context options", async () => {
    const core = coreWith([harness()]);
    const r = renderScreen("/agentcore/harness/list", { core });

    await waitFor(() =>
      core.harness.calls.some((call) => call.method === "listHarnesses" && call.args[1] === 32),
    );
    expect(core.harness.calls.filter((call) => call.method === "listHarnesses")).toEqual([
      {
        method: "listHarnesses",
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
    r.unmount();
  });

  test("enter on a row navigates to that harness's detail screen", async () => {
    const core = coreWith([harness({ harnessName: "pickme", harnessId: "pickme-9" })]);
    // The get screen refetches the single harness; give it a response too.
    core.harness.setGetResponse(
      getResponse(harness({ harnessName: "pickme", harnessId: "pickme-9" })),
    );
    const r = renderScreen("/agentcore/harness/list", { core });

    await waitForText(r.lastFrame, "pickme");
    await r.press("return");
    // Detail screen breadcrumb includes the harness id.
    await waitForText(r.lastFrame, "pickme-9");
    r.unmount();
  });

  test("pages forward and back when the response has a nextToken", async () => {
    const core = new TestCoreClient();
    core.harness.setListResponse({
      harnesses: [
        harness({ harnessName: "alpha_one", harnessId: "a1" }),
        harness({ harnessName: "alpha_two", harnessId: "a2" }),
      ],
      nextToken: "t2",
    });
    core.harness.setListResponse(
      { harnesses: [harness({ harnessName: "beta_one", harnessId: "b1" })] },
      "t2",
    );
    const r = renderScreen("/agentcore/harness/list", { core });

    // Page 1 advertises pagination: key hint plus the status line.
    await waitForText(r.lastFrame, "alpha_one");
    expect(r.lastFrame()).toContain("←→/hl");
    expect(r.lastFrame()).toContain("page 1 · more →");

    // l → page 2, fetched with the nextToken and a terminal-derived maxResults.
    await r.write("l");
    await waitForText(r.lastFrame, "beta_one");
    expect(r.lastFrame()).toContain("page 2");
    expect(r.lastFrame()).not.toContain("more →");
    const paged = core.harness.calls.filter((c) => c.method === "listHarnesses");
    expect(paged.at(-1)!.args[0]).toBe("t2");
    expect(paged.at(-1)!.args[1] as number).toBeGreaterThan(0);

    // ← → back to page 1.
    await r.press("left");
    await waitForText(r.lastFrame, "alpha_one");
    expect(r.lastFrame()).toContain("page 1");
    r.unmount();
  });

  test("no pagination hint when the listing fits one page", async () => {
    const core = coreWith([harness({ harnessName: "only_one" })]);
    const r = renderScreen("/agentcore/harness/list", { core });

    await waitForText(r.lastFrame, "only_one");
    expect(r.lastFrame()).not.toContain("←→/hl");
    expect(r.lastFrame()).not.toContain("page 1");
    r.unmount();
  });

  test("typing l into the filter does not turn the page", async () => {
    const core = new TestCoreClient();
    core.harness.setListResponse({
      harnesses: [harness({ harnessName: "alpha_one", harnessId: "a1" })],
      nextToken: "t2",
    });
    const r = renderScreen("/agentcore/harness/list", { core });

    await waitForText(r.lastFrame, "alpha_one");
    await r.write("/");
    await r.write("l");
    await waitForText(r.lastFrame, "/ Filter this page: l");
    expect(core.harness.calls.some((c) => c.method === "listHarnesses" && c.args[0] === "t2")).toBe(
      false,
    );
    r.unmount();
  });

  test("filtering resets selection to the first matching row", async () => {
    const alpha = harness({ harnessName: "alpha", harnessId: "alpha-1" });
    const core = coreWith([alpha, harness({ harnessName: "beta", harnessId: "beta-2" })]);
    core.harness.setGetResponse(getResponse(alpha));
    const r = renderScreen("/agentcore/harness/list", { core });

    await waitForText(r.lastFrame, "beta");
    await r.press("down");
    await r.write("/");
    for (const character of "alpha") await r.write(character);
    await waitForText(r.lastFrame, "/ Filter this page: alpha");
    await r.press("return");
    await r.press("return");

    await waitForText(r.lastFrame, "agentcore → harness → get → alpha-1");
    await waitFor(() =>
      core.harness.calls.some((call) => call.method === "getHarness" && call.args[0] === "alpha-1"),
    );
    expect(
      core.harness.calls.some((call) => call.method === "getHarness" && call.args[0] === "alpha-1"),
    ).toBe(true);
  });

  test("esc returns to the harness menu", async () => {
    const core = coreWith([harness()]);
    const r = renderScreen("/agentcore/harness/list", { core });

    await waitForText(r.lastFrame, "MyHarness");
    await r.press("escape");
    // Back at the harness command menu — it shows the harness subcommands (e.g.
    // the "get a harness" option), which the list table never does.
    await waitForText(r.lastFrame, "get a harness");
    expect(r.lastFrame()).toContain("manage agentcore harnesses");
    r.unmount();
  });
});
