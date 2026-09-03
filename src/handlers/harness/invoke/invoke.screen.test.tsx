import { test, expect, describe, afterEach } from "bun:test";
import type {
  InvokeHarnessRequest,
  InvokeHarnessStreamOutput,
} from "@aws-sdk/client-bedrock-agentcore";
import type { GetHarnessResponse, HarnessSummary } from "@aws-sdk/client-bedrock-agentcore-control";
import {
  renderScreen,
  waitForText,
  waitFor,
  cleanupScreens,
  StreamController,
  TestCoreClient,
} from "../../../testing";

afterEach(cleanupScreens);

// Behavior tests for the invoke screens: the picker (no :harnessId) and the
// chat (with one), mounted through the real Root at their routes. Streams come
// from the TestCoreClient — canned events for full turns, a StreamController
// when a test needs to hold the stream open and drive it by hand.

const ARN = "arn:aws:bedrock-agentcore:us-east-1:123:harness/MyHarness-abc123";
const CHAT_PATH = "/agentcore/harness/invoke/MyHarness-abc123";

function summary(overrides: Partial<HarnessSummary> = {}): HarnessSummary {
  return {
    harnessId: "MyHarness-abc123",
    harnessName: "MyHarness",
    arn: ARN,
    createdAt: new Date("2026-04-22T21:53:06.235Z"),
    updatedAt: new Date("2026-04-22T21:53:27.062Z"),
    harnessVersion: "1",
    status: "READY",
    ...overrides,
  };
}

// chatCore builds a core ready for the chat screen: a resolvable harness detail
// (the chat needs its ARN) and a canned one-text-block turn.
function chatCore(): TestCoreClient {
  const core = new TestCoreClient();
  core.harness.setGetResponse({ harness: summary() } as GetHarnessResponse);
  core.harness.setInvokeEvents(
    { messageStart: { role: "assistant" } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "Hello from the agent" } } },
    { contentBlockStop: { contentBlockIndex: 0 } },
    { messageStop: { stopReason: "end_turn" } },
    {
      metadata: {
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        metrics: { latencyMs: 800 },
      },
    },
  );
  return core;
}

// sendMessage types `text` into the prompt and presses enter.
async function sendMessage(r: ReturnType<typeof renderScreen>, text: string) {
  await r.write(text);
  await r.press("return");
}

describe("invoke picker screen", () => {
  test("lists harnesses with a chat-flavored subtitle", async () => {
    const core = new TestCoreClient();
    core.harness.setListResponse({
      harnesses: [
        summary({ harnessName: "alpha", harnessId: "alpha-1" }),
        summary({ harnessName: "beta", harnessId: "beta-2" }),
      ],
    });
    const r = renderScreen("/agentcore/harness/invoke", { core });

    await waitForText(r.lastFrame, "alpha");
    expect(r.lastFrame()).toContain("beta");
    expect(r.lastFrame()).toContain("choose a harness to chat with");
    r.unmount();
  });

  test("selecting a harness opens its chat", async () => {
    const core = chatCore();
    core.harness.setListResponse({ harnesses: [summary()] });
    const r = renderScreen("/agentcore/harness/invoke", { core });

    await waitForText(r.lastFrame, "MyHarness");
    await r.press("return");
    // The chat screen's breadcrumb carries the harness id and the prompt mounts.
    await waitForText(r.lastFrame, "invoke → MyHarness-abc123");
    await waitForText(r.lastFrame, "send a message…");
    r.unmount();
  });

  test("shows the error message when the list call fails", async () => {
    const core = new TestCoreClient();
    core.harness.setError(new Error("access denied"));
    const r = renderScreen("/agentcore/harness/invoke", { core });

    await waitForText(r.lastFrame, "Error:");
    expect(r.lastFrame()).toContain("access denied");
    r.unmount();
  });

  test("esc returns to the harness menu", async () => {
    const core = new TestCoreClient();
    core.harness.setListResponse({ harnesses: [summary()] });
    const r = renderScreen("/agentcore/harness/invoke", { core });

    await waitForText(r.lastFrame, "MyHarness");
    await r.press("escape");
    await waitForText(r.lastFrame, "manage AgentCore harnesses");
    r.unmount();
  });
});

describe("invoke chat screen", () => {
  test("sending a message streams the reply and appends a turn summary", async () => {
    const r = renderScreen(CHAT_PATH, { core: chatCore() });

    await waitForText(r.lastFrame, "send a message…");
    await sendMessage(r, "hi agent");

    await waitForText(r.lastFrame, "Hello from the agent");
    await waitForText(r.lastFrame, "end_turn · 15 tokens · 0.8s");
    // The user's message renders as a `❯` line and the prompt is ready again.
    expect(r.lastFrame()).toContain("❯ hi agent");
    expect(r.lastFrame()).toContain("session:");
    r.unmount();
  });

  test("the session id is stable across sends and each send carries only the new message", async () => {
    const core = chatCore();
    const r = renderScreen(CHAT_PATH, { core });

    await waitForText(r.lastFrame, "send a message…");
    await sendMessage(r, "first");
    await waitForText(r.lastFrame, "end_turn");
    await sendMessage(r, "second");
    await waitFor(
      () => core.harness.calls.filter((c) => c.method === "invokeHarness").length === 2,
    );

    const [a, b] = core.harness.calls
      .filter((c) => c.method === "invokeHarness")
      .map((c) => c.args[0] as InvokeHarnessRequest);
    expect(a!.harnessArn).toBe(ARN);
    expect(a!.runtimeSessionId).toBe(b!.runtimeSessionId!);
    expect(a!.runtimeSessionId!.length).toBeGreaterThanOrEqual(33);
    expect(a!.messages).toEqual([{ role: "user", content: [{ text: "first" }] }]);
    expect(b!.messages).toEqual([{ role: "user", content: [{ text: "second" }] }]);
    r.unmount();
  });

  test("a session id in the route resumes that session", async () => {
    const resumed = "resumed-session-0123456789abcdefghijklmn"; // 33+ chars
    const core = chatCore();
    const r = renderScreen(`${CHAT_PATH}/${resumed}`, { core });

    // The bottom bar shows the resumed session immediately.
    await waitForText(r.lastFrame, `session: ${resumed}`);

    // Sends carry the resumed session id, not a fresh one.
    await sendMessage(r, "continue where we left off");
    await waitFor(() => core.harness.calls.some((c) => c.method === "invokeHarness"));
    const invoke = core.harness.calls.find((c) => c.method === "invokeHarness")!;
    expect((invoke.args[0] as InvokeHarnessRequest).runtimeSessionId).toBe(resumed);
    r.unmount();
  });

  test("ctrl+t picks an endpoint and later sends target its qualifier", async () => {
    const core = chatCore();
    core.harness.setListEndpointsResponse({
      endpoints: [
        {
          harnessId: "MyHarness-abc123",
          harnessName: "MyHarness",
          endpointName: "DEFAULT",
          arn: "arn:aws:bedrock-agentcore:us-east-1:123:harness-endpoint/DEFAULT",
          status: "READY",
          liveVersion: "1",
          createdAt: new Date("2026-04-22T21:53:06.235Z"),
          updatedAt: new Date("2026-04-22T21:53:27.062Z"),
        },
        {
          harnessId: "MyHarness-abc123",
          harnessName: "MyHarness",
          endpointName: "prod",
          arn: "arn:aws:bedrock-agentcore:us-east-1:123:harness-endpoint/prod",
          status: "READY",
          liveVersion: "2",
          createdAt: new Date("2026-04-22T21:53:06.235Z"),
          updatedAt: new Date("2026-04-22T21:53:27.062Z"),
        },
      ],
    });
    const r = renderScreen(CHAT_PATH, { core });

    await waitForText(r.lastFrame, "send a message…");
    expect(r.lastFrame()).toContain("qualifier: DEFAULT");

    await r.write("\x14"); // ctrl+t
    await waitForText(r.lastFrame, "choose the endpoint to use");
    await r.press("down"); // prod
    await r.press("return");
    await waitForText(r.lastFrame, "qualifier: prod");

    await sendMessage(r, "hi");
    await waitFor(() => core.harness.calls.some((c) => c.method === "invokeHarness"));
    const invoke = core.harness.calls.find((c) => c.method === "invokeHarness")!;
    expect((invoke.args[0] as InvokeHarnessRequest).qualifier).toBe("prod");
    r.unmount();
  });

  test("esc closes the endpoint picker with the qualifier unchanged", async () => {
    const core = chatCore();
    core.harness.setListEndpointsResponse({
      endpoints: [
        {
          harnessId: "MyHarness-abc123",
          harnessName: "MyHarness",
          endpointName: "prod",
          arn: "arn:aws:bedrock-agentcore:us-east-1:123:harness-endpoint/prod",
          status: "READY",
          createdAt: new Date("2026-04-22T21:53:06.235Z"),
          updatedAt: new Date("2026-04-22T21:53:27.062Z"),
        },
      ],
    });
    const r = renderScreen(CHAT_PATH, { core });

    await waitForText(r.lastFrame, "send a message…");
    await r.write("\x14"); // ctrl+t
    await waitForText(r.lastFrame, "choose the endpoint to use");
    await r.press("escape");
    await waitForText(r.lastFrame, "send a message…");
    expect(r.lastFrame()).toContain("qualifier: DEFAULT");
    r.unmount();
  });

  test("a qualifier in the route targets that endpoint", async () => {
    const core = chatCore();
    const r = renderScreen(`${CHAT_PATH}?qualifier=canary`, { core });

    await waitForText(r.lastFrame, "qualifier: canary");
    await sendMessage(r, "hi");
    await waitFor(() => core.harness.calls.some((c) => c.method === "invokeHarness"));
    const invoke = core.harness.calls.find((c) => c.method === "invokeHarness")!;
    expect((invoke.args[0] as InvokeHarnessRequest).qualifier).toBe("canary");
    r.unmount();
  });

  test("renders reasoning, a successful tool, and a failed tool with result previews", async () => {
    const core = chatCore();
    core.harness.setInvokeEvents(
      { messageStart: { role: "assistant" } },
      {
        contentBlockDelta: {
          contentBlockIndex: 0,
          delta: { reasoningContent: { text: "pondering the request" } },
        },
      },
      { contentBlockStop: { contentBlockIndex: 0 } },
      {
        contentBlockStart: {
          contentBlockIndex: 1,
          start: { toolUse: { toolUseId: "tu-1", name: "get_weather" } },
        },
      },
      {
        contentBlockDelta: {
          contentBlockIndex: 1,
          delta: { toolUse: { input: '{"city":"Portland"}' } },
        },
      },
      { contentBlockStop: { contentBlockIndex: 1 } },
      { messageStop: { stopReason: "tool_use" } },
      { messageStart: { role: "assistant" } },
      {
        contentBlockStart: {
          contentBlockIndex: 0,
          start: { toolResult: { toolUseId: "tu-1", status: "success" } },
        },
      },
      {
        contentBlockDelta: {
          contentBlockIndex: 0,
          delta: { toolResult: [{ text: "Sunny\n25°C\nlow wind" }] },
        },
      },
      { contentBlockStop: { contentBlockIndex: 0 } },
      {
        contentBlockStart: {
          contentBlockIndex: 1,
          start: { toolUse: { toolUseId: "tu-2", name: "get_forecast", serverName: "wx" } },
        },
      },
      { contentBlockStop: { contentBlockIndex: 1 } },
      { messageStop: { stopReason: "tool_use" } },
      { messageStart: { role: "assistant" } },
      {
        contentBlockStart: {
          contentBlockIndex: 0,
          start: { toolResult: { toolUseId: "tu-2", status: "error" } },
        },
      },
      {
        contentBlockDelta: {
          contentBlockIndex: 0,
          delta: { toolResult: [{ text: "upstream timed out" }] },
        },
      },
      { contentBlockStop: { contentBlockIndex: 0 } },
      { messageStop: { stopReason: "end_turn" } },
    );
    const r = renderScreen(CHAT_PATH, { core });

    await waitForText(r.lastFrame, "send a message…");
    await sendMessage(r, "weather?");

    await waitForText(r.lastFrame, "end_turn");
    const frame = r.lastFrame()!;
    expect(frame).toContain("✻ pondering the request");
    expect(frame).toContain("get_weather");
    // Multi-line success result: first line plus the folded line count.
    expect(frame).toContain("└ Sunny … (+2 lines)");
    // The MCP-served tool is prefixed with its server name.
    expect(frame).toContain("wx:get_forecast");
    expect(frame).toContain("└ upstream timed out");
    r.unmount();
  });

  test("esc interrupts a held-open stream, then the chat returns to idle", async () => {
    const core = chatCore();
    const stream = new StreamController<InvokeHarnessStreamOutput>();
    core.harness.queueInvokeStream(stream);
    const r = renderScreen(CHAT_PATH, { core });

    await waitForText(r.lastFrame, "send a message…");
    await sendMessage(r, "take your time");
    await waitForText(r.lastFrame, "working… (esc to interrupt)");

    stream.emit({ messageStart: { role: "assistant" } });
    stream.emit({ contentBlockDelta: { contentBlockIndex: 0, delta: { text: "Thinking" } } });
    await waitForText(r.lastFrame, "Thinking");

    await r.press("escape");
    await waitForText(r.lastFrame, "interrupted");
    // Idle again: the status line shows the session, not the spinner.
    await waitForText(r.lastFrame, "session:");
    expect(r.lastFrame()).not.toContain("working…");
    r.unmount();
  });

  test("ending a held-open stream settles the turn with its summary", async () => {
    const core = chatCore();
    const stream = new StreamController<InvokeHarnessStreamOutput>();
    core.harness.queueInvokeStream(stream);
    const r = renderScreen(CHAT_PATH, { core });

    await waitForText(r.lastFrame, "send a message…");
    await sendMessage(r, "hi");
    await waitForText(r.lastFrame, "working…");

    stream.emit({ messageStart: { role: "assistant" } });
    stream.emit({ contentBlockDelta: { contentBlockIndex: 0, delta: { text: "Done deal" } } });
    stream.emit({ contentBlockStop: { contentBlockIndex: 0 } });
    stream.emit({ messageStop: { stopReason: "end_turn" } });
    stream.end();

    await waitForText(r.lastFrame, "Done deal");
    await waitForText(r.lastFrame, "end_turn");
    await waitForText(r.lastFrame, "session:");
    r.unmount();
  });

  test("an invoke failure renders a ✗ error item and recovers to idle", async () => {
    const core = chatCore();
    const r = renderScreen(CHAT_PATH, { core });

    await waitForText(r.lastFrame, "send a message…");
    // The harness detail is already fetched; only the upcoming invoke fails.
    core.harness.setError(new Error("stream blew up"));
    await sendMessage(r, "hi");

    await waitForText(r.lastFrame, "✗ stream blew up");
    await waitForText(r.lastFrame, "session:");
    r.unmount();
  });

  test("shows the error screen when the harness detail fails to load", async () => {
    const core = new TestCoreClient();
    core.harness.setError(new Error("harness not found"));
    const r = renderScreen(CHAT_PATH, { core });

    await waitForText(r.lastFrame, "Error:");
    expect(r.lastFrame()).toContain("harness not found");
    r.unmount();
  });

  test("esc while idle pops back to the picker", async () => {
    const core = chatCore();
    core.harness.setListResponse({ harnesses: [summary()] });
    const r = renderScreen("/agentcore/harness/invoke", { core });

    await waitForText(r.lastFrame, "MyHarness");
    await r.press("return");
    await waitForText(r.lastFrame, "send a message…");

    await r.press("escape");
    await waitForText(r.lastFrame, "choose a harness to chat with");
    r.unmount();
  });

  test("submitting an empty prompt does not invoke", async () => {
    const core = chatCore();
    const r = renderScreen(CHAT_PATH, { core });

    await waitForText(r.lastFrame, "send a message…");
    await r.press("return");
    await r.write("   ");
    await r.press("return");

    expect(core.harness.calls.filter((c) => c.method === "invokeHarness")).toHaveLength(0);
    r.unmount();
  });

  test("backspace edits the prompt after a completed send", async () => {
    // Regression: sending clears the input from outside TextInput, which used
    // to leave its cursor stranded past the end of the (now shorter) value —
    // backspace then deleted nothing.
    const r = renderScreen(CHAT_PATH, { core: chatCore() });

    await waitForText(r.lastFrame, "send a message…");
    await sendMessage(r, "hi agent");
    await waitForText(r.lastFrame, "end_turn");

    // Non-hex letters, so the random session UUID in the frame can never contain them.
    await r.write("wxyz");
    await waitForText(r.lastFrame, "wxyz");
    await r.write("\x7f"); // backspace
    await waitFor(() => !(r.lastFrame() ?? "").includes("wxyz"));
    expect(r.lastFrame()).toContain("wxy");
    r.unmount();
  });

  test("arrow keys scroll the transcript without crashing", async () => {
    const r = renderScreen(CHAT_PATH, { core: chatCore() });

    await waitForText(r.lastFrame, "send a message…");
    await sendMessage(r, "hi agent");
    await waitForText(r.lastFrame, "end_turn");

    await r.press("up");
    await r.press("up");
    await r.press("down");
    expect(r.lastFrame()).toContain("Hello from the agent");
    r.unmount();
  });
});
