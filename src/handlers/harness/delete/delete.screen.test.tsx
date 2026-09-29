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

// Behavior tests for the delete-harness flow: harness picker → summary +
// confirmation → DeleteHarness call → result.

function coreWithHarness(): TestCoreClient {
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
  core.harness.setGetResponse({
    harness: {
      harnessId: "MyHarness-abc123",
      harnessName: "MyHarness",
      arn: "arn:aws:bedrock-agentcore:us-east-1:123:harness/MyHarness-abc123",
      status: "READY",
      harnessVersion: "1",
    },
  } as GetHarnessResponse);
  core.harness.setDeleteResponse({
    harness: {
      harnessId: "MyHarness-abc123",
      harnessName: "MyHarness",
      status: "DELETING",
    },
  } as GetHarnessResponse);
  return core;
}

describe("harness delete screen", () => {
  test("without a harness id, picking a harness opens its confirmation", async () => {
    const core = coreWithHarness();
    const r = renderScreen("/agentcore/harness/delete", { core });

    await waitForText(r.lastFrame, "MyHarness");
    expect(r.lastFrame()).toContain("choose a harness to delete");

    await r.press("return");
    await waitForText(r.lastFrame, "Delete harness MyHarness?");
    r.unmount();
  });

  test("shows the harness summary and a default-No confirmation", async () => {
    const core = coreWithHarness();
    const r = renderScreen("/agentcore/harness/delete/MyHarness-abc123", { core });

    await waitForText(r.lastFrame, "Delete harness MyHarness?");
    const frame = r.lastFrame()!;
    expect(frame).toContain("arn:aws:bedrock-agentcore:us-east-1:123:harness/MyHarness-abc123");
    expect(frame).toContain("READY");
    expect(frame).toContain("(y/N)");
    r.unmount();
  });

  test("`y` calls DeleteHarness and shows the result", async () => {
    const core = coreWithHarness();
    const r = renderScreen("/agentcore/harness/delete/MyHarness-abc123", { core });

    await waitForText(r.lastFrame, "Delete harness MyHarness?");
    await r.write("y");
    await waitForText(r.lastFrame, "Harness deletion started");
    expect(r.lastFrame()).toContain("DELETING");

    const call = core.harness.calls.find((c) => c.method === "deleteHarness")!;
    expect(call.args[0]).toEqual({ harnessId: "MyHarness-abc123" });
    r.unmount();
  });

  test("enter after success returns to the harness list", async () => {
    const core = coreWithHarness();
    const r = renderScreen("/agentcore/harness/delete/MyHarness-abc123", { core });

    await waitForText(r.lastFrame, "Delete harness MyHarness?");
    await r.write("y");
    await waitForText(r.lastFrame, "Harness deletion started");
    await r.press("return");
    await waitForText(r.lastFrame, "agentcore → harness → list");
    r.unmount();
  });

  test("`n` cancels without calling DeleteHarness", async () => {
    const core = coreWithHarness();
    const r = renderScreen("/agentcore/harness/delete/MyHarness-abc123", { core });

    await waitForText(r.lastFrame, "Delete harness MyHarness?");
    await r.write("n");
    await waitFor(() => !(r.lastFrame() ?? "").includes("Delete harness MyHarness?"));
    expect(core.harness.calls.some((c) => c.method === "deleteHarness")).toBe(false);
    r.unmount();
  });

  test("shows the error and allows returning to the confirmation", async () => {
    const core = coreWithHarness();
    const original = core.harness.deleteHarness.bind(core.harness);
    core.harness.deleteHarness = async () => {
      throw new Error("delete conflict");
    };
    const r = renderScreen("/agentcore/harness/delete/MyHarness-abc123", { core });

    await waitForText(r.lastFrame, "Delete harness MyHarness?");
    await r.write("y");
    await waitForText(r.lastFrame, "delete conflict");

    core.harness.deleteHarness = original;
    await r.press("escape");
    await waitForText(r.lastFrame, "(y/N)");
    r.unmount();
  });
});
