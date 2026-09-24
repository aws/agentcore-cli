import { test, expect, describe, afterEach } from "bun:test";
import type { HarnessEndpoint } from "@aws-sdk/client-bedrock-agentcore-control";
import {
  renderScreen,
  waitForText,
  waitFor,
  cleanupScreens,
  TestCoreClient,
  IMPERATIVE_GLOBAL_CONFIG,
} from "../../../../testing";

afterEach(cleanupScreens);

// Behavior tests for the endpoint delete flow: harness picker → endpoint
// picker → summary + confirmation → DeleteHarnessEndpoint call → result.

function endpoint(): HarnessEndpoint {
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
  };
}

function coreWithEndpoint(): TestCoreClient {
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
  core.harness.setListEndpointsResponse({ endpoints: [endpoint()] });
  core.harness.setGetEndpointResponse({ endpoint: endpoint() });
  core.harness.setDeleteEndpointResponse({
    endpoint: { ...endpoint(), status: "DELETING" },
  });
  return core;
}

describe("harness endpoint delete screen", () => {
  test("walks from harness picker to endpoint picker to confirmation", async () => {
    const core = coreWithEndpoint();
    const r = renderScreen("/agentcore/harness/endpoint/delete", {
      core,
      globalConfig: IMPERATIVE_GLOBAL_CONFIG,
    });

    await waitForText(r.lastFrame, "MyHarness");
    await r.press("return");
    await waitForText(r.lastFrame, "prod");
    expect(r.lastFrame()).toContain("choose an endpoint to delete");
    await r.press("return");
    await waitForText(r.lastFrame, "Delete endpoint prod?");
    r.unmount();
  });

  test("`y` calls DeleteHarnessEndpoint and shows the result", async () => {
    const core = coreWithEndpoint();
    const r = renderScreen("/agentcore/harness/endpoint/delete/MyHarness-abc123/prod", {
      core,

      globalConfig: IMPERATIVE_GLOBAL_CONFIG,
    });

    await waitForText(r.lastFrame, "Delete endpoint prod?");
    await r.write("y");
    await waitForText(r.lastFrame, "Endpoint deletion started");
    expect(r.lastFrame()).toContain("DELETING");

    const call = core.harness.calls.find((c) => c.method === "deleteHarnessEndpoint")!;
    expect(call.args[0]).toEqual({ harnessId: "MyHarness-abc123", endpointName: "prod" });
    r.unmount();
  });

  test("`n` cancels without calling DeleteHarnessEndpoint", async () => {
    const core = coreWithEndpoint();
    const r = renderScreen("/agentcore/harness/endpoint/delete/MyHarness-abc123/prod", {
      core,

      globalConfig: IMPERATIVE_GLOBAL_CONFIG,
    });

    await waitForText(r.lastFrame, "Delete endpoint prod?");
    await r.write("n");
    await waitFor(() => !(r.lastFrame() ?? "").includes("Delete endpoint prod?"));
    expect(core.harness.calls.some((c) => c.method === "deleteHarnessEndpoint")).toBe(false);
    r.unmount();
  });
});
