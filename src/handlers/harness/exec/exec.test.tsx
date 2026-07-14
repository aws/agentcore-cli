import { test, expect, describe } from "bun:test";
import type {
  InvokeAgentRuntimeCommandRequest,
  InvokeAgentRuntimeCommandStreamOutput,
} from "@aws-sdk/client-bedrock-agentcore";
import type { GetHarnessResponse } from "@aws-sdk/client-bedrock-agentcore-control";
import { createRootHandler } from "../../index";
import { createSilentLogger, TestCoreClient, testIO } from "../../../testing";

// Command-flow tests for `harness exec`, driven through the real root handler.
// Like the invoke suite, these use a TestCoreClient because the command
// response is an AsyncIterable stream that fixtures cannot capture.

const ARN = "arn:aws:bedrock-agentcore:us-west-2:123:harness/MyHarness-abc123";

const GET_RESPONSE = {
  harness: { harnessId: "MyHarness-abc123", harnessName: "MyHarness", arn: ARN },
} as GetHarnessResponse;

// A canned run: stdout, stderr, then a clean exit.
const EXEC_EVENTS: InvokeAgentRuntimeCommandStreamOutput[] = [
  { chunk: { contentStart: {} } },
  { chunk: { contentDelta: { stdout: "hello\n" } } },
  { chunk: { contentDelta: { stderr: "warned\n" } } },
  { chunk: { contentStop: { exitCode: 0, status: "COMPLETED" } } },
];

async function run(args: string[], configure?: (core: TestCoreClient) => void) {
  const core = new TestCoreClient();
  core.harness.setGetResponse(GET_RESPONSE);
  core.harness.setExecEvents(...EXEC_EVENTS);
  configure?.(core);
  const io = testIO();
  const root = createRootHandler(core, { io: io.io, logger: createSilentLogger() });
  await root.route(["node", "agentcore", ...args, "--region", "us-west-2"]);
  return { core, stdout: io.stdout() };
}

describe("harness exec", () => {
  test("folds the command stream into JSON output", async () => {
    const { stdout } = await run([
      "harness",
      "exec",
      "--id",
      "MyHarness-abc123",
      "--command",
      "ls",
    ]);

    expect(JSON.parse(stdout)).toEqual({
      command: "ls",
      exitCode: 0,
      status: "success",
      output: "hello\nwarned\n",
    });
  });

  test("addresses the command to the harness ARN with the given body", async () => {
    const { core } = await run([
      "harness",
      "exec",
      "--id",
      "MyHarness-abc123",
      "--command",
      "uname -a",
      "--timeout",
      "60",
    ]);

    const call = core.harness.calls.find((c) => c.method === "invokeAgentRuntimeCommand")!;
    const request = call.args[0] as InvokeAgentRuntimeCommandRequest;
    expect(request.agentRuntimeArn).toBe(ARN);
    expect(request.body).toEqual({ command: "uname -a", timeout: 60 });
    expect(request.runtimeSessionId).toBeUndefined();
    expect((call.args[1] as { region: string }).region).toBe("us-west-2");
  });

  test("--session-id and --qualifier pass through and the session id is echoed", async () => {
    const sessionId = "exec-session-id-that-is-long-enough!";
    const { core, stdout } = await run([
      "harness",
      "exec",
      "--id",
      "MyHarness-abc123",
      "--command",
      "ls",
      "--session-id",
      sessionId,
      "--qualifier",
      "DEFAULT",
    ]);

    const call = core.harness.calls.find((c) => c.method === "invokeAgentRuntimeCommand")!;
    const request = call.args[0] as InvokeAgentRuntimeCommandRequest;
    expect(request.runtimeSessionId).toBe(sessionId);
    expect(request.qualifier).toBe("DEFAULT");
    expect(JSON.parse(stdout).sessionId).toBe(sessionId);
  });

  test("a failing command reports its exit code and error status", async () => {
    const { stdout } = await run(
      ["harness", "exec", "--id", "MyHarness-abc123", "--command", "false"],
      (core) =>
        core.harness.setExecEvents(
          { chunk: { contentDelta: { stderr: "boom\n" } } },
          { chunk: { contentStop: { exitCode: 1, status: "COMPLETED" } } },
        ),
    );

    expect(JSON.parse(stdout)).toMatchObject({ exitCode: 1, status: "error", output: "boom\n" });
  });

  test("errors when --id is omitted", async () => {
    await expect(run(["harness", "exec", "--command", "ls"])).rejects.toThrow(/--id/);
  });

  // Without --command (and outside JSON mode) the handler opens the interactive
  // exec screen instead — that path is covered by the screen tests, since the
  // test IO streams cannot host an Ink render.
  test("errors when --command is omitted in JSON mode", async () => {
    await expect(run(["harness", "exec", "--id", "MyHarness-abc123", "--json"])).rejects.toThrow(
      /--command/,
    );
  });
});
