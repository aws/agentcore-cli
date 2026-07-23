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

describe("harness list screen", () => {
  test("renders each harness with its columns", async () => {
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
  });

  test("makes one initial list request with context options", async () => {
    const core = coreWith([harness()]);
    const r = renderScreen("/agentcore/harness/list", { core });

    await waitFor(() => core.harness.calls.some((call) => call.method === "listHarnesses"));
    expect(core.harness.calls.filter((call) => call.method === "listHarnesses")).toEqual([
      {
        method: "listHarnesses",
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
    r.unmount();
  });
});
