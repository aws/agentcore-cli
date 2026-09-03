import { test, expect, describe, afterEach } from "bun:test";
import type { HarnessEndpoint } from "@aws-sdk/client-bedrock-agentcore-control";
import {
  renderScreen,
  waitForText,
  waitFor,
  cleanupScreens,
  TestCoreClient,
} from "../../../../testing";

afterEach(cleanupScreens);

// Behavior tests for the endpoint listing flow: harness picker → endpoint
// table → endpoint JSON detail.

function endpoint(overrides: Partial<HarnessEndpoint> = {}): HarnessEndpoint {
  return {
    harnessId: "MyHarness-abc123",
    harnessName: "MyHarness",
    endpointName: "prod",
    arn: "arn:aws:bedrock-agentcore:us-east-1:123:harness-endpoint/prod",
    status: "READY",
    liveVersion: "1",
    targetVersion: "1",
    createdAt: new Date("2026-04-22T21:53:06.235Z"),
    updatedAt: new Date("2026-04-22T21:53:27.062Z"),
    ...overrides,
  };
}

function coreWithEndpoints(endpoints: HarnessEndpoint[]): TestCoreClient {
  const core = new TestCoreClient();
  core.harness.setListResponse({
    harnesses: [
      {
        harnessId: "MyHarness-abc123",
        harnessName: "MyHarness",
        arn: "arn:aws:bedrock-agentcore:us-east-1:123:harness/MyHarness-abc123",
        createdAt: new Date("2026-04-22T21:53:06.235Z"),
        updatedAt: new Date("2026-04-22T21:53:27.062Z"),
        harnessVersion: "1",
        status: "READY",
      },
    ],
  });
  core.harness.setListEndpointsResponse({ endpoints });
  return core;
}

describe("harness endpoint list screen", () => {
  test("without a harness id, picking a harness lists its endpoints", async () => {
    const core = coreWithEndpoints([endpoint()]);
    const r = renderScreen("/agentcore/harness/endpoint/list", { core });

    // Harness picker first.
    await waitForText(r.lastFrame, "MyHarness");
    expect(r.lastFrame()).toContain("choose a harness to list endpoints for");

    await r.press("return");
    await waitForText(r.lastFrame, "prod");
    const call = core.harness.calls.find((c) => c.method === "listHarnessEndpoints")!;
    expect(call.args[0]).toBe("MyHarness-abc123");
    r.unmount();
  });

  test("makes one exact scoped endpoint list call", async () => {
    const core = coreWithEndpoints([endpoint()]);
    const r = renderScreen("/agentcore/harness/endpoint/list/MyHarness-abc123", { core });

    await waitFor(() => core.harness.calls.some((call) => call.method === "listHarnessEndpoints"));
    expect(core.harness.calls.filter((call) => call.method === "listHarnessEndpoints")).toEqual([
      {
        method: "listHarnessEndpoints",
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

  test("renders endpoint columns and values", async () => {
    const core = coreWithEndpoints([
      endpoint({
        endpointName: "visible-endpoint",
        liveVersion: "99999",
        targetVersion: "88888",
        status: "UPDATE_FAILED",
        updatedAt: new Date("2026-07-18T02:00:00.000Z"),
      }),
    ]);
    const r = renderScreen("/agentcore/harness/endpoint/list/MyHarness-abc123", { core });

    await waitForText(r.lastFrame, "visible-endpoint");
    const frame = r.lastFrame()!;
    expect(frame).toContain("name");
    expect(frame).toContain("live");
    expect(frame).toContain("target");
    expect(frame).toContain("status");
    expect(frame).toContain("updated UTC");
    expect(frame).toMatch(/visible-endpoint\s+99999\s+88888\s+UPDATE_FAILED/);
    expect(frame).toContain("2026-07-18 02:00");
    r.unmount();
  });

  test("uses harness-specific first-page wording", async () => {
    const core = coreWithEndpoints([]);
    const r = renderScreen("/agentcore/harness/endpoint/list/MyHarness-abc123", { core });

    await waitForText(r.lastFrame, "This harness has no endpoints.");
    expect(r.lastFrame()).not.toContain("No endpoints on this page");
    r.unmount();
  });

  test("enter on a row opens the endpoint's JSON detail", async () => {
    const core = coreWithEndpoints([endpoint()]);
    core.harness.setGetEndpointResponse({ endpoint: endpoint() });
    const r = renderScreen("/agentcore/harness/endpoint/list/MyHarness-abc123", { core });

    await waitForText(r.lastFrame, "prod");
    await r.press("return");
    await waitForText(r.lastFrame, '"endpointName"');
    expect(r.lastFrame()).toContain("endpoint → get → MyHarness-abc123 → prod");
    const call = core.harness.calls.find((c) => c.method === "getHarnessEndpoint")!;
    expect(call.args[0]).toBe("MyHarness-abc123");
    expect(call.args[1]).toBe("prod");
    r.unmount();
  });
});
