import { afterEach, describe, expect, test } from "bun:test";
import type {
  InvokeAgentRuntimeCommandRequest,
  InvokeAgentRuntimeCommandStreamOutput,
} from "@aws-sdk/client-bedrock-agentcore";
import type { GetAgentRuntimeResponse } from "@aws-sdk/client-bedrock-agentcore-control";
import {
  cleanupScreens,
  renderScreen,
  StreamController,
  TestCoreClient,
  waitFor,
  waitForText,
} from "../../../testing";

afterEach(cleanupScreens);
const ID = "checkout-AbCdEf1234";
const ARN = `arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/${ID}`;
const PATH = `/agentcore/runtime/exec/${ID}`;
const SESSION = "12345678-1234-1234-1234-123456789012";

function core() {
  const value = new TestCoreClient();
  value.runtime.setGetResponse({
    agentRuntimeId: ID,
    agentRuntimeArn: ARN,
  } as GetAgentRuntimeResponse);
  value.runtime.setListResponse({
    agentRuntimes: [
      {
        agentRuntimeId: ID,
        agentRuntimeArn: ARN,
        agentRuntimeName: "checkout",
        description: "",
        agentRuntimeVersion: "1",
        status: "READY",
        lastUpdatedAt: new Date(),
      },
    ],
  });
  value.runtime.setListEndpointsResponse({
    runtimeEndpoints: ["DEFAULT", "prod"].map((name) => ({
      name,
      id: name,
      agentRuntimeArn: ARN,
      agentRuntimeEndpointArn: `${ARN}/runtime-endpoint/${name}`,
      status: "READY",
      liveVersion: "1",
      createdAt: new Date(),
      lastUpdatedAt: new Date(),
    })),
  });
  value.runtime.setExecEvents(
    { chunk: { contentDelta: { stdout: "hello\n" } } },
    { chunk: { contentStop: { status: "COMPLETED", exitCode: 0 } } },
  );
  return value;
}
const calls = (value: TestCoreClient) =>
  value.runtime.calls.filter(({ method }) => method === "invokeAgentRuntimeCommand");
async function run(screen: ReturnType<typeof renderScreen>, command: string) {
  await screen.write(command);
  await screen.press("return");
}

describe("Runtime exec TUI", () => {
  test("opens from Runtime details without the standalone gate, reuses its session, and returns", async () => {
    const value = core();
    const screen = renderScreen(`/agentcore/runtime/get/${ID}`, { core: value });
    await waitForText(screen.lastFrame, "run a shell command");
    for (let i = 0; i < 5; i++) await screen.press("down");
    await screen.press("return");
    await waitForText(screen.lastFrame, "DEFAULT");
    await screen.press("return");
    await waitForText(screen.lastFrame, "run a command");
    await run(screen, "pwd");
    await waitForText(screen.lastFrame, "hello");
    value.runtime.setExecEvents({ chunk: { contentStop: { status: "COMPLETED", exitCode: 2 } } });
    await run(screen, "false");
    await waitForText(screen.lastFrame, "exit 2");
    const [first, second] = calls(value).map(
      ({ args }) => args[0] as InvokeAgentRuntimeCommandRequest,
    );
    expect(first).toMatchObject({
      agentRuntimeArn: ARN,
      qualifier: "DEFAULT",
      body: { command: "pwd" },
    });
    expect(second!.runtimeSessionId).toBe(first!.runtimeSessionId);
    expect(value.harness.calls).toEqual([]);
    await screen.press("escape");
    await waitForText(screen.lastFrame, "show the full JSON definition");
  });

  test("keeps CLI session and timeout through endpoint selection and starts fresh on endpoint changes", async () => {
    const value = core();
    const screen = renderScreen(`${PATH}?session-id=${SESSION}&timeout=60`, { core: value });
    await waitForText(screen.lastFrame, "DEFAULT");
    await screen.press("return");
    await waitForText(screen.lastFrame, `session: ${SESSION}`);
    await run(screen, "pwd");
    await waitForText(screen.lastFrame, "hello");
    expect(calls(value)[0]!.args[0]).toMatchObject({
      runtimeSessionId: SESSION,
      body: { command: "pwd", timeout: 60 },
    });
    await screen.write("\x14");
    await waitForText(screen.lastFrame, "prod");
    await screen.press("escape");
    await waitForText(screen.lastFrame, "$ pwd");
    await screen.write("\x14");
    await waitForText(screen.lastFrame, "prod");
    await screen.press("down");
    await screen.press("return");
    await waitForText(screen.lastFrame, "qualifier: prod");
    expect(screen.lastFrame()).not.toContain("$ pwd");
    await run(screen, "ls");
    await waitForText(screen.lastFrame, "hello");
    expect(calls(value)[1]!.args[0]).toMatchObject({ qualifier: "prod" });
    expect(
      (calls(value)[1]!.args[0] as InvokeAgentRuntimeCommandRequest).runtimeSessionId,
    ).not.toBe(SESSION);
  });

  test("interrupts streamed commands, preserves the next draft, and aborts on unmount", async () => {
    const value = core();
    const stream = new StreamController<InvokeAgentRuntimeCommandStreamOutput>();
    value.runtime.queueExecStream(stream);
    const screen = renderScreen(`${PATH}/DEFAULT`, { core: value });
    await waitForText(screen.lastFrame, "run a command");
    await run(screen, "sleep 99");
    await waitForText(screen.lastFrame, "working");
    stream.emit({ chunk: { contentDelta: { stdout: "partial" } } });
    await waitForText(screen.lastFrame, "partial");
    await run(screen, "pwd");
    expect(calls(value)).toHaveLength(1);
    await screen.press("escape");
    await waitForText(screen.lastFrame, "interrupted");
    expect((calls(value)[0]!.args[2] as AbortSignal).aborted).toBe(true);
    value.runtime.queueExecStream(new StreamController<InvokeAgentRuntimeCommandStreamOutput>());
    await screen.press("return");
    await waitForText(screen.lastFrame, "working");
    screen.unmount();
    await waitFor(() => (calls(value)[1]!.args[2] as AbortSignal).aborted);
  });

  test("selects a Runtime and keeps long commands editable in a narrow terminal", async () => {
    const screen = renderScreen("/agentcore/runtime/exec", { core: core() });
    await waitForText(screen.lastFrame, ID);
    await screen.press("return");
    await waitForText(screen.lastFrame, "DEFAULT");
    await screen.press("return");
    await waitForText(screen.lastFrame, "run a command");
    await screen.resize(60, 20);
    await screen.write(`printf '${"long-command-".repeat(12)}visible-tail'`);
    expect(screen.lastFrame()).toContain("visible-tail'");
    expect(screen.lastFrame()).toContain("session:");
    expect(screen.lastFrame()!.split("\n")).toHaveLength(20);
  });
});
