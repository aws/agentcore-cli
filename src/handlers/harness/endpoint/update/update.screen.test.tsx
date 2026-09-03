import { test, expect, describe, afterEach } from "bun:test";
import type {
  GetHarnessEndpointResponse,
  HarnessVersionSummary,
} from "@aws-sdk/client-bedrock-agentcore-control";
import {
  renderScreen,
  waitForText,
  waitFor,
  cleanupScreens,
  TestCoreClient,
} from "../../../../testing";

afterEach(cleanupScreens);

// Behavior tests for the endpoint update wizard: harness picker → endpoint
// picker → version step prefilled → review → submit (changed fields only).

function version(v: string): HarnessVersionSummary {
  return {
    harnessId: "MyHarness-abc123",
    harnessName: "MyHarness",
    arn: "arn:aws:bedrock-agentcore:us-east-1:123:harness/MyHarness-abc123",
    harnessVersion: v,
    status: "READY",
    createdAt: new Date("2026-04-22T21:53:06.235Z"),
    updatedAt: new Date("2026-04-22T21:53:27.062Z"),
  };
}

function endpointResponse(): GetHarnessEndpointResponse {
  return {
    endpoint: {
      harnessId: "MyHarness-abc123",
      harnessName: "MyHarness",
      endpointName: "prod",
      arn: "arn:aws:bedrock-agentcore:us-east-1:123:harness-endpoint/prod",
      status: "READY",
      liveVersion: "1",
      targetVersion: "1",
      description: "old description",
      createdAt: new Date("2026-04-22T21:53:06.235Z"),
      updatedAt: new Date("2026-04-22T21:53:27.062Z"),
    },
  };
}

function coreForUpdate(): TestCoreClient {
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
  core.harness.setListEndpointsResponse({ endpoints: [endpointResponse().endpoint!] });
  core.harness.setGetEndpointResponse(endpointResponse());
  core.harness.setListVersionsResponse({ harnessVersions: [version("1"), version("2")] });
  core.harness.setUpdateEndpointResponse({
    endpoint: { ...endpointResponse().endpoint!, targetVersion: "2", status: "UPDATING" },
  });
  return core;
}

describe("harness endpoint update wizard", () => {
  test("walks harness picker → endpoint picker → wizard", async () => {
    const core = coreForUpdate();
    const r = renderScreen("/agentcore/harness/endpoint/update", { core });

    await waitForText(r.lastFrame, "MyHarness");
    await r.press("return");
    await waitForText(r.lastFrame, "prod");
    expect(r.lastFrame()).toContain("choose an endpoint to update");
    await r.press("return");
    await waitForText(r.lastFrame, "which harness version should this endpoint serve?");
    r.unmount();
  });

  test("repointing at a new version submits only targetVersion", async () => {
    const core = coreForUpdate();
    const r = renderScreen("/agentcore/harness/endpoint/update/MyHarness-abc123/prod", { core });

    // The endpoint's current target (version 1) is preselected; no "latest"
    // option exists in update mode.
    await waitForText(r.lastFrame, "● version 1");
    expect(r.lastFrame()).toContain("│ ● version 1");
    expect(r.lastFrame()).not.toContain("latest");
    await r.press("up"); // version 2 (sorted newest first)
    await waitForText(r.lastFrame, "● version 2");
    await r.press("return");

    await waitForText(r.lastFrame, "sent to UpdateHarnessEndpoint");
    await r.press("return");
    await waitForText(r.lastFrame, "endpoint updated");

    const call = core.harness.calls.find((c) => c.method === "updateHarnessEndpoint")!;
    expect(call.args[0]).toEqual({
      harnessId: "MyHarness-abc123",
      endpointName: "prod",
      targetVersion: "2",
    });
    r.unmount();
  });

  test("keeping the version unchanged submits only the endpoint identity", async () => {
    const core = coreForUpdate();
    const r = renderScreen("/agentcore/harness/endpoint/update/MyHarness-abc123/prod", { core });

    await waitForText(r.lastFrame, "● version 1");
    await r.press("return"); // keep version
    await waitForText(r.lastFrame, "sent to UpdateHarnessEndpoint");
    await r.press("return");

    await waitFor(() => core.harness.calls.some((c) => c.method === "updateHarnessEndpoint"));
    const call = core.harness.calls.find((c) => c.method === "updateHarnessEndpoint")!;
    expect(call.args[0]).toEqual({
      harnessId: "MyHarness-abc123",
      endpointName: "prod",
    });
    r.unmount();
  });
});
