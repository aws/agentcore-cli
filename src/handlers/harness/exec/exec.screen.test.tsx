import { test, expect, describe, afterEach } from "bun:test";
import type {
  InvokeAgentRuntimeCommandRequest,
  InvokeAgentRuntimeCommandStreamOutput,
  InvokeHarnessRequest,
} from "@aws-sdk/client-bedrock-agentcore";
import type { GetHarnessResponse, HarnessSummary } from "@aws-sdk/client-bedrock-agentcore-control";
import {
  renderScreen,
  waitForText,
  cleanupScreens,
  StreamController,
  TestCoreClient,
} from "../../../testing";

afterEach(cleanupScreens);

// Behavior tests for exec mode in the shared chat screen: the exec route (which
// starts in exec mode) and the ctrl+e toggle from a chat. The `$` prompt runs
// shell commands in the session's container via InvokeAgentRuntimeCommand and
// shows their output inline in the same transcript as chat turns.

const ARN = "arn:aws:bedrock-agentcore:us-east-1:123:harness/MyHarness-abc123";
const EXEC_PATH = "/agentcore/harness/exec/MyHarness-abc123";
const CTRL_E = "\x05";

function summary(): HarnessSummary {
  return {
    harnessId: "MyHarness-abc123",
    harnessName: "MyHarness",
    arn: ARN,
    createdAt: new Date("2026-04-22T21:53:06.235Z"),
    updatedAt: new Date("2026-04-22T21:53:27.062Z"),
    harnessVersion: "1",
    status: "READY",
  };
}

// execCore builds a core ready for the chat: a resolvable harness detail plus
// canned streams for both modes (a clean `ls` run and a one-line chat turn).
function execCore(): TestCoreClient {
  const core = new TestCoreClient();
  core.harness.setGetResponse({ harness: summary() } as GetHarnessResponse);
  core.harness.setExecEvents(
    { chunk: { contentStart: {} } },
    { chunk: { contentDelta: { stdout: "bin\n" } } },
    { chunk: { contentDelta: { stdout: "usr\n" } } },
    { chunk: { contentStop: { exitCode: 0, status: "COMPLETED" } } },
  );
  core.harness.setInvokeEvents(
    { messageStart: { role: "assistant" } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "Hello from the agent" } } },
    { contentBlockStop: { contentBlockIndex: 0 } },
    { messageStop: { stopReason: "end_turn" } },
  );
  return core;
}

async function type(r: ReturnType<typeof renderScreen>, text: string) {
  await r.write(text);
  await r.press("return");
}

describe("exec screen", () => {
  test("the exec route opens a picker, and selection lands in exec mode", async () => {
    const core = execCore();
    core.harness.setListResponse({ harnesses: [summary()] });
    const r = renderScreen("/agentcore/harness/exec", { core });

    await waitForText(r.lastFrame, "choose a harness to exec into");
    await waitForText(r.lastFrame, "MyHarness");
    await r.press("return");
    await waitForText(r.lastFrame, "exec → MyHarness-abc123");
    await waitForText(r.lastFrame, "run a command…");
    expect(r.lastFrame()).toContain("$ ");
    r.unmount();
  });

  test("enter runs the command in the chat session's container and shows output inline", async () => {
    const core = execCore();
    const r = renderScreen(EXEC_PATH, { core });

    await waitForText(r.lastFrame, "run a command…");
    await type(r, "ls /");

    await waitForText(r.lastFrame, "bin");
    const frame = r.lastFrame()!;
    expect(frame).toContain("$ ls /");
    expect(frame).toContain("usr");
    // Clean exit: no exit-code line, prompt idle again.
    expect(frame).not.toContain("exit 0");
    expect(frame).toContain("session:");

    const call = core.harness.calls.find((c) => c.method === "invokeAgentRuntimeCommand")!;
    const request = call.args[0] as InvokeAgentRuntimeCommandRequest;
    expect(request.agentRuntimeArn).toBe(ARN);
    expect(request.body).toEqual({ command: "ls /" });
    expect(request.runtimeSessionId!.length).toBeGreaterThanOrEqual(33);
    r.unmount();
  });

  test("a session id in the route resumes that session", async () => {
    const resumed = "resumed-session-0123456789abcdefghijklmn"; // 33+ chars
    const core = execCore();
    const r = renderScreen(`${EXEC_PATH}/${resumed}`, { core });

    await waitForText(r.lastFrame, `session: ${resumed}`);
    await type(r, "pwd");
    await waitFor(() => core.harness.calls.some((c) => c.method === "invokeAgentRuntimeCommand"));
    const call = core.harness.calls.find((c) => c.method === "invokeAgentRuntimeCommand")!;
    expect((call.args[0] as InvokeAgentRuntimeCommandRequest).runtimeSessionId).toBe(resumed);
    expect((call.args[0] as InvokeAgentRuntimeCommandRequest).qualifier).toBe("DEFAULT");
    r.unmount();
  });

  test("a failing command shows its output and exit code in red", async () => {
    const core = execCore();
    core.harness.setExecEvents(
      { chunk: { contentDelta: { stderr: "ls: cannot access '/nope'\n" } } },
      { chunk: { contentStop: { exitCode: 2, status: "COMPLETED" } } },
    );
    const r = renderScreen(EXEC_PATH, { core });

    await waitForText(r.lastFrame, "run a command…");
    await type(r, "ls /nope");

    await waitForText(r.lastFrame, "exit 2");
    expect(r.lastFrame()).toContain("ls: cannot access '/nope'");
    r.unmount();
  });

  test("ctrl+e flips between exec and chat mode", async () => {
    const r = renderScreen(EXEC_PATH, { core: execCore() });

    await waitForText(r.lastFrame, "run a command…");
    expect(r.lastFrame()).toContain("[ctl+e] chat mode");

    await r.write(CTRL_E);
    await waitForText(r.lastFrame, "send a message…");
    expect(r.lastFrame()).toContain("[ctl+e] exec mode");

    await r.write(CTRL_E);
    await waitForText(r.lastFrame, "run a command…");
    r.unmount();
  });

  test("chat turns and exec commands share one session and one transcript", async () => {
    const core = execCore();
    // Start on the invoke route (chat mode), then toggle into exec mode.
    const r = renderScreen("/agentcore/harness/invoke/MyHarness-abc123", { core });

    await waitForText(r.lastFrame, "send a message…");
    await type(r, "hi agent");
    await waitForText(r.lastFrame, "Hello from the agent");

    await r.write(CTRL_E);
    await waitForText(r.lastFrame, "run a command…");
    await type(r, "ls /");
    await waitForText(r.lastFrame, "bin");

    // Both the conversation and the command are in the same transcript.
    const frame = r.lastFrame()!;
    expect(frame).toContain("❯ hi agent");
    expect(frame).toContain("$ ls /");

    // And both ran in the same runtime session (the same container).
    const invoke = core.harness.calls.find((c) => c.method === "invokeHarness")!;
    const exec = core.harness.calls.find((c) => c.method === "invokeAgentRuntimeCommand")!;
    expect((exec.args[0] as InvokeAgentRuntimeCommandRequest).runtimeSessionId).toBe(
      (invoke.args[0] as InvokeHarnessRequest).runtimeSessionId!,
    );
    r.unmount();
  });

  test("esc interrupts a running command", async () => {
    const core = execCore();
    const stream = new StreamController<InvokeAgentRuntimeCommandStreamOutput>();
    core.harness.queueExecStream(stream);
    const r = renderScreen(EXEC_PATH, { core });

    await waitForText(r.lastFrame, "run a command…");
    await type(r, "sleep 999");
    await waitForText(r.lastFrame, "working…");

    stream.emit({ chunk: { contentDelta: { stdout: "tick\n" } } });
    await waitForText(r.lastFrame, "tick");

    await r.press("escape");
    await waitForText(r.lastFrame, "interrupted");
    await waitForText(r.lastFrame, "session:");
    r.unmount();
  });

  test("an exec failure renders a ✗ error item and recovers to idle", async () => {
    const core = execCore();
    const r = renderScreen(EXEC_PATH, { core });

    await waitForText(r.lastFrame, "run a command…");
    core.harness.setError(new Error("runtime unreachable"));
    await type(r, "ls");

    await waitForText(r.lastFrame, "✗ runtime unreachable");
    await waitForText(r.lastFrame, "session:");
    r.unmount();
  });

  test("empty input in exec mode does not run anything", async () => {
    const core = execCore();
    const r = renderScreen(EXEC_PATH, { core });

    await waitForText(r.lastFrame, "run a command…");
    await r.press("return");

    expect(core.harness.calls.filter((c) => c.method === "invokeAgentRuntimeCommand")).toHaveLength(
      0,
    );
    r.unmount();
  });
});
