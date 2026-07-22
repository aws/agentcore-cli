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
    expect(frame).toContain("name");
    expect(frame).toContain("version");
    expect(frame).toContain("status");
    expect(frame).toContain("updatedAt");

    await r.resize(50, 20);
    await waitForText(r.lastFrame, "alpha");
    const narrow = r.lastFrame()!;
    expect(narrow).toContain("name");
    expect(narrow).toContain("version");
    expect(narrow).not.toContain("status");
    expect(narrow).not.toContain("updatedAt");
    expect(narrow).not.toContain("READY");
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
