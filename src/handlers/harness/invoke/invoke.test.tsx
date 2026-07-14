import { test, expect, describe } from "bun:test";
import type {
  InvokeHarnessRequest,
  InvokeHarnessStreamOutput,
} from "@aws-sdk/client-bedrock-agentcore";
import type { GetHarnessResponse } from "@aws-sdk/client-bedrock-agentcore-control";
import { createRootHandler } from "../../index";
import { TestCoreClient, testExecutionPolicy, testIO } from "../../../testing";

// Command-flow tests for `harness invoke`, driven through the real root handler
// exactly as the CLI runs it. Unlike the get/list suites these use a
// TestCoreClient rather than recorded fixtures: the invoke response is an
// AsyncIterable stream, which the fixture serialization cannot capture.

const ARN = "arn:aws:bedrock-agentcore:us-west-2:123:harness/MyHarness-abc123";

const GET_RESPONSE = {
  harness: { harnessId: "MyHarness-abc123", harnessName: "MyHarness", arn: ARN },
} as GetHarnessResponse;

// A canned full turn: one streamed text block plus closing metadata.
const TURN_EVENTS: InvokeHarnessStreamOutput[] = [
  { messageStart: { role: "assistant" } },
  { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "Hello" } } },
  { contentBlockDelta: { contentBlockIndex: 0, delta: { text: " there" } } },
  { contentBlockStop: { contentBlockIndex: 0 } },
  { messageStop: { stopReason: "end_turn" } },
  {
    metadata: {
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      metrics: { latencyMs: 800 },
    },
  },
];

// run routes `args` beneath `agentcore` over a fresh handler tree and returns
// the core (for call assertions) and captured stdout.
async function run(args: string[], configure?: (core: TestCoreClient) => void) {
  const core = new TestCoreClient();
  core.harness.setGetResponse(GET_RESPONSE);
  core.harness.setInvokeEvents(...TURN_EVENTS);
  configure?.(core);
  const io = testIO();
  const root = createRootHandler(core, io.io);
  await root.route(["node", "agentcore", ...args, "--region", "us-west-2"], testExecutionPolicy());
  return { core, stdout: io.stdout() };
}

describe("harness invoke", () => {
  test("folds the stream into a JSON transcript", async () => {
    const { stdout } = await run([
      "harness",
      "invoke",
      "--id",
      "MyHarness-abc123",
      "--prompt",
      "hi",
    ]);

    const out = JSON.parse(stdout);
    expect(out.stopReason).toBe("end_turn");
    expect(out.usage.totalTokens).toBe(15);
    expect(out.latencyMs).toBe(800);
    expect(typeof out.sessionId).toBe("string");
    expect(out.transcript).toEqual([
      { kind: "user", text: "hi" },
      { kind: "text", text: "Hello there", streaming: false },
    ]);
  });

  test("resolves the harness ARN and sends a single user message with a fresh session id", async () => {
    const { core } = await run(["harness", "invoke", "--id", "MyHarness-abc123", "--prompt", "hi"]);

    const get = core.harness.calls.find((c) => c.method === "getHarness")!;
    expect(get.args[0]).toBe("MyHarness-abc123");

    const invoke = core.harness.calls.find((c) => c.method === "invokeHarness")!;
    const request = invoke.args[0] as InvokeHarnessRequest;
    expect(request.harnessArn).toBe(ARN);
    // Omitting --qualifier targets the DEFAULT endpoint explicitly.
    expect(request.qualifier).toBe("DEFAULT");
    expect(request.messages).toEqual([{ role: "user", content: [{ text: "hi" }] }]);
    expect(request.runtimeSessionId!.length).toBeGreaterThanOrEqual(33);
    expect(request.runtimeSessionId!.length).toBeLessThanOrEqual(100);
    expect((invoke.args[1] as { region: string }).region).toBe("us-west-2");
  });

  test("--session-id is passed through and echoed in the output", async () => {
    const sessionId = "custom-session-id-that-is-long-enough";
    const { core, stdout } = await run([
      "harness",
      "invoke",
      "--id",
      "MyHarness-abc123",
      "--prompt",
      "hi",
      "--session-id",
      sessionId,
    ]);

    const invoke = core.harness.calls.find((c) => c.method === "invokeHarness")!;
    expect((invoke.args[0] as InvokeHarnessRequest).runtimeSessionId).toBe(sessionId);
    expect(JSON.parse(stdout).sessionId).toBe(sessionId);
  });

  test("--session-id shorter than 33 characters is rejected", async () => {
    await expect(
      run(["harness", "invoke", "--id", "X", "--prompt", "hi", "--session-id", "too-short"]),
    ).rejects.toThrow();
  });

  test("--qualifier is passed through on the request", async () => {
    const { core } = await run([
      "harness",
      "invoke",
      "--id",
      "MyHarness-abc123",
      "--prompt",
      "hi",
      "--qualifier",
      "DEFAULT",
    ]);

    const invoke = core.harness.calls.find((c) => c.method === "invokeHarness")!;
    expect((invoke.args[0] as InvokeHarnessRequest).qualifier).toBe("DEFAULT");
  });

  test("a stream-borne validationException becomes an error transcript item", async () => {
    const { stdout } = await run(
      ["harness", "invoke", "--id", "MyHarness-abc123", "--prompt", "hi"],
      (core) =>
        core.harness.setInvokeEvents({
          validationException: { message: "session id malformed" },
        } as unknown as InvokeHarnessStreamOutput),
    );

    expect(JSON.parse(stdout).transcript).toEqual([
      { kind: "user", text: "hi" },
      { kind: "error", message: "session id malformed" },
    ]);
  });

  test("errors when --id is omitted", async () => {
    await expect(run(["harness", "invoke", "--prompt", "hi"])).rejects.toThrow(/--id/);
  });

  // Without --prompt (and outside JSON mode) the handler opens the interactive
  // chat instead — that path is covered by the screen tests, since the test IO
  // streams cannot host an Ink render.
  test("errors when --prompt is omitted in JSON mode", async () => {
    await expect(run(["harness", "invoke", "--id", "MyHarness-abc123", "--json"])).rejects.toThrow(
      /--prompt/,
    );
  });
});
