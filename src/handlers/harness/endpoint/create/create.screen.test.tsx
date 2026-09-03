import { test, expect, describe, afterEach } from "bun:test";
import type {
  CreateHarnessEndpointResponse,
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

// Behavior tests for the endpoint create wizard: name → target version (picked
// from the harness's real versions) → review → submit.

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

function coreForCreate(): TestCoreClient {
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
  core.harness.setListVersionsResponse({ harnessVersions: [version("1"), version("2")] });
  core.harness.setCreateEndpointResponse({
    endpoint: {
      harnessId: "MyHarness-abc123",
      harnessName: "MyHarness",
      endpointName: "prod",
      arn: "arn:aws:bedrock-agentcore:us-east-1:123:harness-endpoint/prod",
      status: "CREATING",
      targetVersion: "2",
      createdAt: new Date("2026-04-22T21:53:06.235Z"),
      updatedAt: new Date("2026-04-22T21:53:27.062Z"),
    },
  } as CreateHarnessEndpointResponse);
  return core;
}

describe("harness endpoint create wizard", () => {
  test("without a harness id, picking a harness opens the wizard", async () => {
    const core = coreForCreate();
    const r = renderScreen("/agentcore/harness/endpoint/create", { core });

    await waitForText(r.lastFrame, "MyHarness");
    expect(r.lastFrame()).toContain("choose a harness to create an endpoint for");
    await r.press("return");
    await waitForText(r.lastFrame, "what should this endpoint be called?");
    expect(r.lastFrame()).toContain("│❯ production");
    r.unmount();
  });

  test("walks name → version → review and creates", async () => {
    const core = coreForCreate();
    const r = renderScreen("/agentcore/harness/endpoint/create/MyHarness-abc123", { core });

    await waitForText(r.lastFrame, "what should this endpoint be called?");
    await r.write("prod");
    await r.press("return");

    // Versions listed newest first after the "latest" default.
    await waitForText(r.lastFrame, "which harness version should this endpoint serve?");
    expect(r.lastFrame()).toContain("● latest");
    expect(r.lastFrame()).toContain("│ ● latest");
    expect(r.lastFrame()).toContain("version 2");
    expect(r.lastFrame()).toContain("version 1");
    await r.press("down"); // version 2
    await waitForText(r.lastFrame, "● version 2");
    await r.press("return");

    await waitForText(r.lastFrame, "sent to CreateHarnessEndpoint");
    expect(r.lastFrame()).toContain('"endpointName"');
    await r.press("return");

    await waitForText(r.lastFrame, "endpoint created");
    const call = core.harness.calls.find((c) => c.method === "createHarnessEndpoint")!;
    expect(call.args[0]).toEqual({
      harnessId: "MyHarness-abc123",
      endpointName: "prod",
      targetVersion: "2",
    });

    // Enter lands on the endpoint's detail.
    core.harness.setGetEndpointResponse({
      endpoint: {
        harnessId: "MyHarness-abc123",
        harnessName: "MyHarness",
        endpointName: "prod",
        arn: "arn:aws:bedrock-agentcore:us-east-1:123:harness-endpoint/prod",
        status: "CREATING",
        createdAt: new Date("2026-04-22T21:53:06.235Z"),
        updatedAt: new Date("2026-04-22T21:53:27.062Z"),
      },
    });
    await r.press("return");
    await waitForText(r.lastFrame, "endpoint → get → MyHarness-abc123 → prod");
    r.unmount();
  });

  test("keeping `latest` omits targetVersion from the request", async () => {
    const core = coreForCreate();
    const r = renderScreen("/agentcore/harness/endpoint/create/MyHarness-abc123", { core });

    await waitForText(r.lastFrame, "what should this endpoint be called?");
    await r.write("prod");
    await r.press("return");
    await waitForText(r.lastFrame, "● latest");
    await r.press("return");
    await waitForText(r.lastFrame, "sent to CreateHarnessEndpoint");
    await r.press("return");

    await waitFor(() => core.harness.calls.some((c) => c.method === "createHarnessEndpoint"));
    const call = core.harness.calls.find((c) => c.method === "createHarnessEndpoint")!;
    expect(call.args[0]).toEqual({ harnessId: "MyHarness-abc123", endpointName: "prod" });
    r.unmount();
  });
});
