import { test, expect, describe, afterEach } from "bun:test";
import type { HarnessVersionSummary } from "@aws-sdk/client-bedrock-agentcore-control";
import {
  renderScreen,
  waitForText,
  waitFor,
  cleanupScreens,
  TestCoreClient,
} from "../../../../testing";

afterEach(cleanupScreens);

// Behavior tests for the version listing flow: harness picker → version table →
// version JSON detail.

function version(overrides: Partial<HarnessVersionSummary> = {}): HarnessVersionSummary {
  return {
    harnessId: "MyHarness-abc123",
    harnessName: "MyHarness",
    arn: "arn:aws:bedrock-agentcore:us-east-1:123:harness/MyHarness-abc123",
    harnessVersion: "1",
    status: "READY",
    createdAt: new Date("2026-04-22T21:53:06.235Z"),
    updatedAt: new Date("2026-04-22T21:53:27.062Z"),
    ...overrides,
  };
}

function coreWithVersions(versions: HarnessVersionSummary[]): TestCoreClient {
  const core = new TestCoreClient();
  core.harness.setListResponse({
    harnesses: [
      {
        harnessId: "MyHarness-abc123",
        harnessName: "MyHarness",
        arn: "arn:aws:bedrock-agentcore:us-east-1:123:harness/MyHarness-abc123",
        createdAt: new Date("2026-04-22T21:53:06.235Z"),
        updatedAt: new Date("2026-04-22T21:53:27.062Z"),
        harnessVersion: "2",
        status: "READY",
      },
    ],
  });
  core.harness.setListVersionsResponse({ harnessVersions: versions });
  return core;
}

describe("harness version list screen", () => {
  test("without a harness id, picking a harness lists its versions", async () => {
    const core = coreWithVersions([version({ harnessVersion: "42" })]);
    const r = renderScreen("/agentcore/harness/version/list", { core });

    await waitForText(r.lastFrame, "MyHarness");
    expect(r.lastFrame()).toContain("choose a harness to list versions for");

    await r.press("return");
    await waitForText(r.lastFrame, "42");
    expect(r.lastFrame()).toContain("version → list → MyHarness-abc123");
    r.unmount();
  });

  test("makes one exact scoped version list call", async () => {
    const core = coreWithVersions([version()]);
    const r = renderScreen("/agentcore/harness/version/list/MyHarness-abc123", { core });

    await waitFor(() => core.harness.calls.some((call) => call.method === "listHarnessVersions"));
    expect(core.harness.calls.filter((call) => call.method === "listHarnessVersions")).toEqual([
      {
        method: "listHarnessVersions",
        args: [
          "MyHarness-abc123",
          undefined,
          expect.any(Number),
          {
            region: "us-east-1",
            endpointUrl: undefined,
          },
        ],
      },
    ]);
    r.unmount();
  });

  test("sorts numeric versions newest first", async () => {
    const core = coreWithVersions([
      version({ harnessVersion: "2", status: "UPDATE_FAILED" }),
      version({ harnessVersion: "10", status: "READY" }),
    ]);
    const r = renderScreen("/agentcore/harness/version/list/MyHarness-abc123", { core });

    await waitForText(r.lastFrame, "UPDATE_FAILED");
    const frame = r.lastFrame()!;
    const lines = frame.split("\n");
    const versionTen = lines.findIndex((line) => line.includes("10") && line.includes("READY"));
    const versionTwo = lines.findIndex(
      (line) => line.includes("2") && line.includes("UPDATE_FAILED"),
    );
    expect(versionTen).toBeGreaterThanOrEqual(0);
    expect(versionTwo).toBeGreaterThanOrEqual(0);
    expect(versionTen).toBeLessThan(versionTwo);
    r.unmount();
  });

  test("shows version-only columns when narrow and all columns when wide", async () => {
    const core = coreWithVersions([
      version({
        harnessVersion: "123",
        status: "UPDATE_FAILED",
        createdAt: new Date("2026-07-18T02:00:00.000Z"),
      }),
    ]);
    const r = renderScreen("/agentcore/harness/version/list/MyHarness-abc123", { core });

    await r.resize(50);
    await waitForText(r.lastFrame, "123");
    const narrow = r.lastFrame()!;
    expect(narrow).toContain("version");
    expect(narrow).toContain("123");
    expect(narrow).not.toContain("status");
    expect(narrow).not.toContain("createdAt");
    expect(narrow).not.toContain("UPDATE_FAILED");
    expect(narrow).not.toContain("2026-07-18T02:00:00.000Z");

    await r.resize(120);
    await waitForText(r.lastFrame, "createdAt");
    const wide = r.lastFrame()!;
    expect(wide).toContain("version");
    expect(wide).toContain("status");
    expect(wide).toContain("createdAt");
    expect(wide).toContain("123");
    expect(wide).toContain("UPDATE_FAILED");
    expect(wide).toContain("2026-07-18T02:00:00.000Z");
    r.unmount();
  });

  test("uses harness-version wording for empty pages", async () => {
    const firstPage = renderScreen("/agentcore/harness/version/list/MyHarness-abc123");
    await waitForText(firstPage.lastFrame, "No versions found.");
    firstPage.unmount();

    const core = coreWithVersions([version({ harnessVersion: "42" })]);
    core.harness.setListVersionsResponse({
      harnessVersions: [version({ harnessVersion: "42" })],
      nextToken: "v2",
    });
    core.harness.setListVersionsResponse({ harnessVersions: [] }, "v2");
    const laterPage = renderScreen("/agentcore/harness/version/list/MyHarness-abc123", { core });

    await waitForText(laterPage.lastFrame, "page 1 · more →");
    await laterPage.write("l");
    await waitForText(
      laterPage.lastFrame,
      "No versions on this page for harness MyHarness-abc123.",
    );
    expect(laterPage.lastFrame()).not.toContain("No versions found.");
    laterPage.unmount();
  });

  test("enter on a row opens the version's JSON detail", async () => {
    const core = coreWithVersions([version({ harnessVersion: "42" })]);
    core.harness.setGetVersionResponse({
      harness: {
        harnessId: "MyHarness-abc123",
        harnessName: "MyHarness",
        harnessVersion: "42",
        status: "READY",
      },
    } as Awaited<ReturnType<TestCoreClient["harness"]["getHarnessVersion"]>>);
    const r = renderScreen("/agentcore/harness/version/list/MyHarness-abc123", { core });

    await waitForText(r.lastFrame, "READY");
    await r.press("return");
    await waitForText(r.lastFrame, '"harnessVersion"');
    expect(r.lastFrame()).toContain("version → get → MyHarness-abc123 → 42");
    const call = core.harness.calls.find((c) => c.method === "getHarnessVersion")!;
    expect(call.args[0]).toBe("MyHarness-abc123");
    expect(call.args[1]).toBe("42");
    r.unmount();
  });
});
