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

// Behavior tests for the update-harness wizard: the create steps minus name,
// prefilled from the current configuration, submitting only what changed.

function currentHarness(): GetHarnessResponse {
  return {
    harness: {
      harnessId: "MyHarness-abc123",
      harnessName: "MyHarness",
      arn: "arn:aws:bedrock-agentcore:us-east-1:123:harness/MyHarness-abc123",
      executionRoleArn: "arn:aws:iam::123:role/Existing",
      status: "READY",
      harnessVersion: "1",
      systemPrompt: [{ text: "You are v1." }],
      tools: [
        { type: "agentcore_browser", config: { agentCoreBrowser: {} } },
        {
          type: "inline_function",
          name: "custom",
          config: { inlineFunction: { description: "d", inputSchema: {} } },
        },
      ],
      memory: { managedMemoryConfiguration: { arn: "arn:managed" } },
    },
  } as GetHarnessResponse;
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
        harnessVersion: "1",
        status: "READY",
      },
    ],
  });
  core.harness.setGetResponse(currentHarness());
  core.harness.setUpdateResponse({
    harness: {
      harnessId: "MyHarness-abc123",
      harnessName: "MyHarness",
      status: "UPDATING",
      harnessVersion: "2",
    },
  } as GetHarnessResponse);
  return core;
}

describe("harness update wizard", () => {
  test("without a harness id, picking a harness opens its wizard", async () => {
    const core = coreForUpdate();
    const r = renderScreen("/agentcore/harness/update", { core });

    await waitForText(r.lastFrame, "MyHarness");
    expect(r.lastFrame()).toContain("choose a harness to update");
    await r.press("return");
    await waitForText(r.lastFrame, "choose a model");
    r.unmount();
  });

  test("starts on model (no rename) with values prefilled from the harness", async () => {
    const core = coreForUpdate();
    const r = renderScreen("/agentcore/harness/update/MyHarness-abc123", { core });

    // The harness has no bedrock model configured, so keep-current is
    // preselected; enter leaves the model untouched.
    await waitForText(r.lastFrame, "● keep current");
    // The name step is absent from the stepper.
    expect(r.lastFrame()).not.toContain("Name");
    await r.press("return");

    // Managed memory is the current config and is preselected.
    await waitForText(r.lastFrame, "● managed");
    await r.press("return");

    // Tools reflect the current config: browser on.
    await waitForText(r.lastFrame, "[✓] browser");
    r.unmount();
  });

  test("prefills the current bedrock model and sends nothing when unchanged", async () => {
    const core = coreForUpdate();
    const current = currentHarness();
    current.harness!.model = {
      bedrockModelConfig: { modelId: "us.anthropic.claude-opus-4-8" },
    };
    core.harness.setGetResponse(current);
    const r = renderScreen("/agentcore/harness/update/MyHarness-abc123", { core });

    // The harness's bedrock provider is preselected. Its persisted model id is
    // revealed after confirming the provider.
    await waitForText(r.lastFrame, "● bedrock");
    expect(r.lastFrame()).not.toContain("us.anthropic.claude-opus-4-8");
    await r.press("return"); // into the model id field
    await waitForText(r.lastFrame, "us.anthropic.claude-opus-4-8");
    await r.press("return"); // accept it unchanged
    await waitForText(r.lastFrame, "● managed");
    await r.press("return");
    await waitForText(r.lastFrame, "[✓] browser");
    await r.press("return");
    await waitForText(r.lastFrame, "type or paste the agent's instructions");
    await r.write(" Now v2.");
    await r.write("\x04");
    await waitForText(r.lastFrame, "sent to UpdateHarness");
    await r.press("return");

    await waitFor(() => core.harness.calls.some((c) => c.method === "updateHarness"));
    const call = core.harness.calls.find((c) => c.method === "updateHarness")!;
    expect(call.args[0]).toEqual({
      harnessId: "MyHarness-abc123",
      systemPrompt: [{ text: "You are v1. Now v2." }],
    });
    r.unmount();
  });

  test("changing the model submits a request with just that field", async () => {
    const core = coreForUpdate();
    const r = renderScreen("/agentcore/harness/update/MyHarness-abc123", { core });

    await waitForText(r.lastFrame, "● keep current");
    await r.press("down"); // bedrock
    await waitForText(r.lastFrame, "● bedrock");
    await r.press("return"); // focus the model id field
    await r.write("us.anthropic.claude-haiku-4-5-20251001-v1:0");
    await r.press("return");
    await waitForText(r.lastFrame, "● managed");
    await r.press("return");
    await waitForText(r.lastFrame, "[✓] browser");
    await r.press("return");
    await waitForText(r.lastFrame, "type or paste the agent's instructions");
    await r.write("\x04");
    await waitForText(r.lastFrame, "sent to UpdateHarness");
    await r.press("return");

    await waitFor(() => core.harness.calls.some((c) => c.method === "updateHarness"));
    const call = core.harness.calls.find((c) => c.method === "updateHarness")!;
    expect(call.args[0]).toEqual({
      harnessId: "MyHarness-abc123",
      model: { bedrockModelConfig: { modelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0" } },
    });
    r.unmount();
  });

  test("changing only the prompt submits a request with just that field", async () => {
    const core = coreForUpdate();
    const r = renderScreen("/agentcore/harness/update/MyHarness-abc123", { core });

    await waitForText(r.lastFrame, "● keep current");
    await r.press("return"); // model unchanged
    await waitForText(r.lastFrame, "● managed");
    await r.press("return"); // memory unchanged
    await waitForText(r.lastFrame, "[✓] browser");
    await r.press("return"); // tools unchanged
    await waitForText(r.lastFrame, "type or paste the agent's instructions");
    expect(r.lastFrame()).toContain("You are v1.");
    await r.write(" Now v2."); // append to the existing prompt
    await r.write("\x04");
    await waitForText(r.lastFrame, "sent to UpdateHarness");
    expect(r.lastFrame()).toContain("only the changed fields are sent");
    await r.press("return"); // update

    await waitForText(r.lastFrame, "harness updated");
    const frame = r.lastFrame()!;
    expect(frame).toMatch(/id\s+MyHarness-abc123/);
    expect(frame).toMatch(/status\s+UPDATING/);
    expect(frame).toMatch(/version\s+2/);

    const call = core.harness.calls.find((c) => c.method === "updateHarness")!;
    expect(call.args[0]).toEqual({
      harnessId: "MyHarness-abc123",
      systemPrompt: [{ text: "You are v1. Now v2." }],
    });
    r.unmount();
  });

  test("disabling memory sends the wrapped disabled configuration", async () => {
    const core = coreForUpdate();
    const r = renderScreen("/agentcore/harness/update/MyHarness-abc123", { core });

    await waitForText(r.lastFrame, "● keep current");
    await r.press("return"); // model unchanged
    await waitForText(r.lastFrame, "● managed");
    await r.press("down"); // byo
    await r.press("down"); // disabled
    await waitForText(r.lastFrame, "● disabled");
    await r.press("return");
    await waitForText(r.lastFrame, "[✓] browser");
    await r.press("return");
    await waitForText(r.lastFrame, "type or paste the agent's instructions");
    await r.write("\x04");
    await waitForText(r.lastFrame, "sent to UpdateHarness");
    await r.press("return");

    await waitFor(() => core.harness.calls.some((c) => c.method === "updateHarness"));
    const call = core.harness.calls.find((c) => c.method === "updateHarness")!;
    expect(call.args[0]).toEqual({
      harnessId: "MyHarness-abc123",
      memory: { optionalValue: { disabled: {} } },
    });
    r.unmount();
  });

  test("toggling a tool off keeps unmodeled tools in the replacement list", async () => {
    const core = coreForUpdate();
    const r = renderScreen("/agentcore/harness/update/MyHarness-abc123", { core });

    await waitForText(r.lastFrame, "● keep current");
    await r.press("return"); // model unchanged
    await waitForText(r.lastFrame, "● managed");
    await r.press("return");
    await waitForText(r.lastFrame, "[✓] browser");
    await r.write(" "); // toggle browser off
    await waitFor(() => (r.lastFrame() ?? "").includes("[ ] browser"));
    await r.press("return");
    await waitForText(r.lastFrame, "type or paste the agent's instructions");
    await r.write("\x04");
    await waitForText(r.lastFrame, "sent to UpdateHarness");
    await r.press("return");

    await waitFor(() => core.harness.calls.some((c) => c.method === "updateHarness"));
    const call = core.harness.calls.find((c) => c.method === "updateHarness")!;
    // The inline_function tool the form doesn't model survives the update.
    expect(call.args[0]).toEqual({
      harnessId: "MyHarness-abc123",
      tools: [
        {
          type: "inline_function",
          name: "custom",
          config: { inlineFunction: { description: "d", inputSchema: {} } },
        },
      ],
    });
    r.unmount();
  });
});
