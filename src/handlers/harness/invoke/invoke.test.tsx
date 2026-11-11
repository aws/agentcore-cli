import { test, expect, describe, spyOn } from "bun:test";
import type {
  InvokeHarnessRequest,
  InvokeHarnessStreamOutput,
} from "@aws-sdk/client-bedrock-agentcore";
import type { GetHarnessResponse } from "@aws-sdk/client-bedrock-agentcore-control";
import { createRootHandler } from "../../index";
import {
  createSilentLogger,
  expectError,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
  StreamController,
  tick,
  waitFor,
} from "../../../testing";
import { InputValidationError } from "../../../errors";
import * as tui from "../../../tui";
import { HarnessInvokeLaunchContextKey } from "./launchContext";

// Command-flow tests for `harness invoke`, driven through the real root handler
// exactly as the CLI runs it. Unlike the get/list suites these use a
// TestCoreClient rather than recorded fixtures: the invoke response is an
// AsyncIterable stream, which the fixture serialization cannot capture.

const ARN = "arn:aws:bedrock-agentcore:us-west-2:123456789012:harness/MyHarness-abc123";

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
async function run(args: string[], configure?: (core: TestCoreClient) => void, io = testIO()) {
  const core = new TestCoreClient();
  core.harness.setGetResponse(GET_RESPONSE);
  core.harness.setInvokeEvents(...TURN_EVENTS);
  configure?.(core);
  const root = createRootHandler(core, {
    io: io.io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });
  await root.route(["node", "agentcore", ...args, "--region", "us-west-2"]);
  return { core, stdout: io.stdout() };
}

describe("harness invoke", () => {
  test.each([false, true])(
    "waits for the transcript and respects JSON mode (json=%s)",
    async (json) => {
      const io = testIO({ isTTY: true });
      const stream = new StreamController<InvokeHarnessStreamOutput>();
      const pending = run(
        [
          "harness",
          "invoke",
          "--id",
          "MyHarness-abc123",
          "--prompt",
          "hi",
          ...(json ? ["--json"] : []),
        ],
        (core) => core.harness.queueInvokeStream(stream),
        io,
      );
      try {
        if (json) await tick(120);
        else await waitFor(() => io.stderr().includes("Invoking harness..."));
        expect(io.stdout()).toBe("");
        if (json) expect(io.stderr()).toBe("");
      } finally {
        for (const event of TURN_EVENTS) stream.emit(event);
        stream.end();
        await pending;
      }
      expect(JSON.parse(io.stdout()).stopReason).toBe("end_turn");
      if (json) expect(io.stderr()).toBe("");
    },
  );

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
    expect(request.runtimeUserId).toBeUndefined();
    expect(request.runtimeSessionId!.length).toBeGreaterThanOrEqual(33);
    expect(request.runtimeSessionId!.length).toBeLessThanOrEqual(100);
    expect((invoke.args[1] as { region: string }).region).toBe("us-west-2");
  });

  test("looks up a CUSTOM_JWT harness before invoking with a bearer token", async () => {
    const { core } = await run(
      ["harness", "invoke", "--id", "MyHarness-abc123", "--prompt", "hi", "--bearer-token", "-"],
      (core) =>
        core.harness.setGetResponse({
          harness: {
            ...GET_RESPONSE.harness,
            authorizerConfiguration: {
              customJWTAuthorizer: { discoveryUrl: "https://idp.example.test" },
            },
          },
        } as GetHarnessResponse),
      testIO({ stdin: "secret-token\n" }),
    );
    expect(core.harness.calls.find((call) => call.method === "getHarness")?.args[0]).toBe(
      "MyHarness-abc123",
    );
    expect(core.harness.calls.find((call) => call.method === "invokeHarness")?.args[0]).toEqual(
      expect.objectContaining({ harnessArn: ARN, bearerToken: "secret-token" }),
    );
  });

  test("requires a bearer token for a CUSTOM_JWT harness", async () => {
    await expect(
      run(["harness", "invoke", "--id", "MyHarness-abc123", "--prompt", "hi"], (core) =>
        core.harness.setGetResponse({
          harness: {
            ...GET_RESPONSE.harness,
            authorizerConfiguration: {
              customJWTAuthorizer: { discoveryUrl: "https://idp.example.test" },
            },
          },
        } as GetHarnessResponse),
      ),
    ).rejects.toThrow("CUSTOM_JWT Harness requires --bearer-token");
  });

  test("rejects a bearer token for an IAM harness", async () => {
    await expect(
      run([
        "harness",
        "invoke",
        "--id",
        "MyHarness-abc123",
        "--prompt",
        "hi",
        "--bearer-token",
        "secret-token",
      ]),
    ).rejects.toThrow("IAM Harness does not accept --bearer-token");
  });

  test("--bearer-token requires a one-shot prompt", async () => {
    await expect(
      run(["harness", "invoke", "--id", "MyHarness-abc123", "--bearer-token", "secret-token"]),
    ).rejects.toThrow("--prompt");
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
      "--user-id",
      "user-123",
    ]);

    const invoke = core.harness.calls.find((c) => c.method === "invokeHarness")!;
    const request = invoke.args[0] as InvokeHarnessRequest;
    expect(request.runtimeSessionId).toBe(sessionId);
    expect(request.runtimeUserId).toBe("user-123");
    expect(request.actorId).toBeUndefined();
    expect(JSON.parse(stdout).sessionId).toBe(sessionId);
  });

  test("passes --user-id to the TUI without a prompt", async () => {
    const render = spyOn(tui, "renderTuiAt").mockResolvedValue(undefined);
    try {
      const { core } = await run([
        "harness",
        "invoke",
        "--id",
        "MyHarness-abc123",
        "--user-id",
        "user-123",
        "--qualifier",
        "prod",
        "--session-id",
        "custom-session-id-that-is-long-enough",
      ]);

      expect(render).toHaveBeenCalledTimes(1);
      expect(render.mock.calls[0]![0]).toBe(
        "/agentcore/harness/invoke/MyHarness-abc123/custom-session-id-that-is-long-enough?qualifier=prod",
      );
      expect(render.mock.calls[0]![1].value(HarnessInvokeLaunchContextKey)).toEqual({
        harnessId: "MyHarness-abc123",
        userId: "user-123",
      });
      expect(core.harness.calls).toEqual([]);
    } finally {
      render.mockRestore();
    }
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
    await expectError(run(["harness", "invoke", "--prompt", "hi"]), /--id/, InputValidationError);
  });

  test("errors when --prompt is omitted in JSON mode", async () => {
    await expect(run(["harness", "invoke", "--id", "MyHarness-abc123", "--json"])).rejects.toThrow(
      /--prompt/,
    );
  });
});
