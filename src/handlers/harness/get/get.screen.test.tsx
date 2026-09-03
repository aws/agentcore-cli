import { test, expect, describe, afterEach } from "bun:test";
import type { GetHarnessResponse } from "@aws-sdk/client-bedrock-agentcore-control";
import {
  renderScreen,
  waitForText,
  waitFor,
  cleanupScreens,
  TestCoreClient,
} from "../../../testing";

afterEach(cleanupScreens);

// Behavior tests for the harness hub (get) screen and its JSON detail. The
// harness id comes from the route path; the hub fetches that single harness,
// shows a summary overlay, and offers actions that jump into the harness's
// flows.

// getResponse builds a GetHarnessResponse. The screens render whatever
// `harness` they receive, so a minimal shape (cast to the SDK's Harness) is
// enough to test behavior without constructing every field.
function getResponse(): GetHarnessResponse {
  return {
    harness: {
      harnessId: "MyHarness-abc123",
      harnessName: "MyHarness",
      arn: "arn:aws:bedrock-agentcore:us-east-1:123:harness/MyHarness-abc123",
      executionRoleArn: "arn:aws:iam::123:role/MyRole",
      status: "READY",
      harnessVersion: "1",
      updatedAt: new Date("2026-04-22T21:53:27.062Z"),
    },
  } as GetHarnessResponse;
}

function hubScreen() {
  const core = new TestCoreClient();
  core.harness.setGetResponse(getResponse());
  return { core, r: renderScreen("/agentcore/harness/get/MyHarness-abc123", { core }) };
}

describe("harness hub screen", () => {
  test("renders the summary overlay once loaded", async () => {
    const { r } = hubScreen();

    await waitForText(
      r.lastFrame,
      "arn:aws:bedrock-agentcore:us-east-1:123:harness/MyHarness-abc123",
    );
    const frame = r.lastFrame()!;
    expect(frame).toContain("MyHarness-abc123");
    expect(frame).toContain("READY");
    expect(frame).toMatch(/version\s+1/);
    r.unmount();
  });

  test("lists the harness actions", async () => {
    const { r } = hubScreen();

    await waitForText(r.lastFrame, "detail");
    const frame = r.lastFrame()!;
    expect(frame).toContain("show the full JSON definition");
    expect(frame).toContain("endpoints");
    expect(frame).toContain("versions");
    expect(frame).toContain("invoke");
    expect(frame).toContain("exec");
    r.unmount();
  });

  test("fetches the harness id taken from the route path", async () => {
    const { core, r } = hubScreen();

    await waitFor(() => core.harness.calls.length > 0);
    const call = core.harness.calls.find((c) => c.method === "getHarness")!;
    expect(call.args[0]).toBe("MyHarness-abc123");
    r.unmount();
  });

  test("shows the error message when the get call fails", async () => {
    const core = new TestCoreClient();
    core.harness.setError(new Error("harness not found"));
    const r = renderScreen("/agentcore/harness/get/does-not-exist", { core });

    await waitForText(r.lastFrame, "Error:");
    expect(r.lastFrame()).toContain("harness not found");
    r.unmount();
  });

  test("enter on `detail` opens the JSON view", async () => {
    const { r } = hubScreen();

    await waitForText(r.lastFrame, "detail");
    await r.press("return");
    await waitForText(r.lastFrame, "agentcore → harness → get → MyHarness-abc123 → json");
    expect(r.lastFrame()).toContain('"harnessName"');
    r.unmount();
  });

  test("up navigation returns to the previous action", async () => {
    const { r } = hubScreen();

    await waitForText(r.lastFrame, "detail");
    await r.press("down");
    await r.press("up");
    await r.press("return");
    await waitForText(r.lastFrame, "agentcore → harness → get → MyHarness-abc123 → json");
    r.unmount();
  });

  test("enter on `endpoints` opens this harness's endpoint list", async () => {
    const { core, r } = hubScreen();
    core.harness.setListEndpointsResponse({
      endpoints: [
        {
          harnessId: "MyHarness-abc123",
          harnessName: "MyHarness",
          endpointName: "prod",
          arn: "arn:aws:bedrock-agentcore:us-east-1:123:harness-endpoint/prod",
          status: "READY",
          liveVersion: "1",
          targetVersion: "1",
          createdAt: new Date("2026-04-22T21:53:06.235Z"),
          updatedAt: new Date("2026-04-22T21:53:27.062Z"),
        },
      ],
    });

    await waitForText(r.lastFrame, "detail");
    await r.press("down");
    await r.press("return");
    await waitForText(r.lastFrame, "prod");
    await waitFor(() => core.harness.calls.some((c) => c.method === "listHarnessEndpoints"));
    r.unmount();
  });

  test("enter on `invoke` opens the chat for this harness", async () => {
    const { r } = hubScreen();

    await waitForText(r.lastFrame, "detail");
    await r.press("down"); // endpoints
    await r.press("down"); // versions
    await r.press("down"); // invoke
    await r.press("return");
    await waitForText(r.lastFrame, "agentcore → harness → invoke → MyHarness-abc123");
    r.unmount();
  });

  test("bare `get` with no id redirects to the list screen", async () => {
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
    const r = renderScreen("/agentcore/harness/get", { core });

    // The redirect lands on the list, which fetches harnesses.
    await waitForText(r.lastFrame, "MyHarness");
    await waitFor(() => core.harness.calls.some((c) => c.method === "listHarnesses"));
    r.unmount();
  });
});

describe("harness JSON detail screen", () => {
  test("wraps long JSON values instead of truncating them", async () => {
    const longPrompt = `${"reply sarcastically but accurately and concisely ".repeat(5)}WRAP_SENTINEL`;
    const response = getResponse();
    response.harness!.systemPrompt = [{ text: longPrompt }];

    const core = new TestCoreClient();
    core.harness.setGetResponse(response);
    const r = renderScreen("/agentcore/harness/get/MyHarness-abc123/json", { core });

    await waitForText(r.lastFrame, "WRAP_SENTINEL");
    r.unmount();
  });

  test("renders the harness JSON and scrolls without crashing", async () => {
    const core = new TestCoreClient();
    core.harness.setGetResponse(getResponse());
    const r = renderScreen("/agentcore/harness/get/MyHarness-abc123/json", { core });

    await waitForText(r.lastFrame, '"harnessName"');
    await r.press("down");
    await r.press("up");
    await r.write("j");
    await r.write("k");
    expect(r.lastFrame()).toContain('"harnessName"');
    r.unmount();
  });
});
