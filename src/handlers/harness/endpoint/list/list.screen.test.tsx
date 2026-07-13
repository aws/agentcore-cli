import { test, expect, describe, afterEach } from "bun:test";
import type { HarnessEndpoint } from "@aws-sdk/client-bedrock-agentcore-control";
import { renderScreen, waitForText, cleanupScreens, TestCoreClient } from "../../../../testing";

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

  test("renders each endpoint as a row with its versions and status", async () => {
    const core = coreWithEndpoints([
      endpoint(),
      endpoint({ endpointName: "staging", targetVersion: "2", status: "UPDATING" }),
    ]);
    const r = renderScreen("/agentcore/harness/endpoint/list/MyHarness-abc123", { core });

    await waitForText(r.lastFrame, "prod");
    const frame = r.lastFrame()!;
    expect(frame).toContain("staging");
    expect(frame).toContain("READY");
    expect(frame).toContain("UPDATING");
    r.unmount();
  });

  test("says so when the harness has no endpoints", async () => {
    const core = coreWithEndpoints([]);
    const r = renderScreen("/agentcore/harness/endpoint/list/MyHarness-abc123", { core });

    await waitForText(r.lastFrame, "no endpoints");
    r.unmount();
  });

  test("pages forward and back when the response has a nextToken", async () => {
    const core = coreWithEndpoints([]);
    core.harness.setListEndpointsResponse({
      endpoints: [endpoint({ endpointName: "alpha_ep" }), endpoint({ endpointName: "beta_ep" })],
      nextToken: "ep2",
    });
    core.harness.setListEndpointsResponse(
      { endpoints: [endpoint({ endpointName: "gamma_ep" })] },
      "ep2",
    );
    const r = renderScreen("/agentcore/harness/endpoint/list/MyHarness-abc123", { core });

    await waitForText(r.lastFrame, "alpha_ep");
    expect(r.lastFrame()).toContain("page 1 · more →");

    await r.write("l");
    await waitForText(r.lastFrame, "gamma_ep");
    expect(r.lastFrame()).toContain("page 2");
    const paged = core.harness.calls.filter((c) => c.method === "listHarnessEndpoints");
    expect(paged.at(-1)!.args[1]).toBe("ep2");
    expect(paged.at(-1)!.args[2] as number).toBeGreaterThan(0);

    await r.write("h");
    await waitForText(r.lastFrame, "alpha_ep");
    expect(r.lastFrame()).toContain("page 1");
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

  test("shows the error message when the list call fails", async () => {
    const core = new TestCoreClient();
    core.harness.setError(new Error("access denied"));
    const r = renderScreen("/agentcore/harness/endpoint/list/MyHarness-abc123", { core });

    await waitForText(r.lastFrame, "Error:");
    expect(r.lastFrame()).toContain("access denied");
    r.unmount();
  });
});
