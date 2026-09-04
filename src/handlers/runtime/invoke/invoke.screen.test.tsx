import { afterEach, describe, expect, test } from "bun:test";
import { ValidationException } from "@aws-sdk/client-bedrock-agentcore";
import type {
  AgentRuntime,
  AgentRuntimeEndpoint,
  GetAgentRuntimeResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import type { RuntimeInvokeRequest } from "../types";
import {
  cleanupScreens,
  renderScreen,
  TestCoreClient,
  waitFor,
  waitForText,
} from "../../../testing";
import { RuntimeInvokeLaunchContextKey } from "./launchContext";

const REGION = "us-east-1";
const RUNTIME_ID = "runtime-123";
const QUALIFIER = "prod";
const RUNTIME_ARN = `arn:aws:bedrock-agentcore:${REGION}:123456789012:runtime/${RUNTIME_ID}`;
const CONSOLE_PATH = `/agentcore/runtime/invoke/${RUNTIME_ID}/${QUALIFIER}`;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(cleanupScreens);

function runtime(overrides: Partial<AgentRuntime> = {}): AgentRuntime {
  return {
    agentRuntimeArn: RUNTIME_ARN,
    agentRuntimeId: RUNTIME_ID,
    agentRuntimeVersion: "3",
    agentRuntimeName: "checkout",
    description: "Checkout Runtime",
    lastUpdatedAt: new Date("2026-07-20T12:34:56.000Z"),
    status: "READY",
    ...overrides,
  };
}

function endpoint(overrides: Partial<AgentRuntimeEndpoint> = {}): AgentRuntimeEndpoint {
  return {
    name: QUALIFIER,
    id: QUALIFIER,
    liveVersion: "3",
    targetVersion: "3",
    status: "READY",
    agentRuntimeEndpointArn: `${RUNTIME_ARN}/endpoint/${QUALIFIER}`,
    agentRuntimeArn: RUNTIME_ARN,
    description: "Production endpoint",
    createdAt: new Date("2026-07-19T01:02:03.000Z"),
    lastUpdatedAt: new Date("2026-07-20T12:34:56.000Z"),
    ...overrides,
  };
}

function responseBody(...chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  return (async function* () {
    yield* chunks;
  })();
}

function invokeRequests(core: TestCoreClient): RuntimeInvokeRequest[] {
  return core.runtime.calls
    .filter((call) => call.method === "invokeRuntime")
    .map((call) => call.args[0] as RuntimeInvokeRequest);
}

function displayedSessionId(frame: string | undefined): string | undefined {
  return frame?.match(/Ready · Session ID: ([^ ·\n]+)/)?.[1];
}

describe("Runtime invoke routing", () => {
  test("selects a Runtime and endpoint before opening one console", async () => {
    const runtimeId = "runtime/blue one";
    const qualifier = "prod/green one";
    const core = new TestCoreClient();
    core.runtime
      .setListResponse({
        agentRuntimes: [
          runtime({
            agentRuntimeId: runtimeId,
            agentRuntimeName: "pick-runtime",
            agentRuntimeArn: `arn:aws:bedrock-agentcore:${REGION}:123456789012:runtime/${runtimeId}`,
          }),
        ],
      })
      .setListEndpointsResponse({
        runtimeEndpoints: [endpoint({ name: qualifier, id: qualifier })],
      })
      .setGetResponse({
        agentRuntimeArn: `arn:aws:bedrock-agentcore:${REGION}:123456789012:runtime/${runtimeId}`,
      } as GetAgentRuntimeResponse);
    const screen = renderScreen("/agentcore/runtime/invoke", { core });

    await waitForText(screen.lastFrame, "pick-runtime");
    await screen.press("return");
    await waitForText(screen.lastFrame, qualifier);
    await screen.press("return");

    await waitForText(
      screen.lastFrame,
      `agentcore → runtime → invoke → ${runtimeId} → ${qualifier}`,
    );
    await waitForText(screen.lastFrame, "Enter JSON payload");
  });

  test("esc from an initial endpoint picker returns to the Runtime picker", async () => {
    const core = new TestCoreClient();
    core.runtime.setListEndpointsResponse({ runtimeEndpoints: [endpoint()] }).setListResponse({
      agentRuntimes: [runtime({ agentRuntimeName: "back-to-runtime-picker" })],
    });
    const screen = renderScreen(`/agentcore/runtime/invoke/${RUNTIME_ID}`, { core });

    await waitForText(screen.lastFrame, QUALIFIER);
    await screen.press("escape");

    await waitForText(screen.lastFrame, "back-to-runtime-picker");
    expect(screen.lastFrame()).toContain("agentcore → runtime → invoke");
  });

  test("keeps a CLI-selected session while choosing an endpoint", async () => {
    const sessionId = "cli-selected-session";
    const core = new TestCoreClient();
    core.runtime
      .setListEndpointsResponse({ runtimeEndpoints: [endpoint()] })
      .setGetResponse({ agentRuntimeArn: RUNTIME_ARN } as GetAgentRuntimeResponse);
    const screen = renderScreen(`/agentcore/runtime/invoke/${RUNTIME_ID}`, {
      core,
      withContext: (ctx) =>
        ctx.withValue(RuntimeInvokeLaunchContextKey, {
          runtimeId: RUNTIME_ID,
          runtimeSessionId: sessionId,
        }),
    });

    await waitForText(screen.lastFrame, QUALIFIER);
    await screen.press("return");

    await waitForText(screen.lastFrame, `Ready · Session ID: ${sessionId}`);
    expect(screen.lastFrame()).not.toContain("MCP session ID");
  });

  test("escape switches endpoints without restoring the launch session", async () => {
    const nextQualifier = "back-endpoint";
    const core = new TestCoreClient();
    core.runtime
      .setGetResponse({ agentRuntimeArn: RUNTIME_ARN } as GetAgentRuntimeResponse)
      .setListEndpointsResponse({
        runtimeEndpoints: [endpoint({ name: nextQualifier, id: nextQualifier })],
      })
      .setInvokeResponse({
        statusCode: 200,
        contentType: "text/plain",
        body: responseBody(Buffer.from("ok")),
      });
    const screen = renderScreen(CONSOLE_PATH, {
      core,
      withContext: (ctx) =>
        ctx.withValue(RuntimeInvokeLaunchContextKey, {
          runtimeId: RUNTIME_ID,
          runtimeSessionId: "cli-selected-session",
        }),
    });

    await waitForText(screen.lastFrame, "Session ID: cli-selected-session");
    await screen.press("escape");
    await waitForText(screen.lastFrame, nextQualifier);
    await screen.press("return");
    await waitForText(
      screen.lastFrame,
      `agentcore → runtime → invoke → ${RUNTIME_ID} → ${nextQualifier}`,
    );
    const nextSessionId = displayedSessionId(screen.lastFrame());
    expect(nextSessionId).toMatch(UUID_PATTERN);
    expect(nextSessionId).not.toBe("cli-selected-session");

    await screen.write("{}");
    await screen.press("return");
    await waitFor(() => invokeRequests(core).length === 1);
    expect(invokeRequests(core)[0]!.runtimeSessionId).toBe(nextSessionId);
  });

  test("shows the full Runtime lookup error", async () => {
    const core = new TestCoreClient();
    core.runtime.getRuntime = async () => {
      throw Object.assign(new Error("not authorized for this Runtime"), {
        name: "AccessDeniedException",
      });
    };
    const screen = renderScreen(CONSOLE_PATH, { core });

    await waitForText(screen.lastFrame, "AccessDeniedException");
    await waitForText(screen.lastFrame, "not authorized for this Runtime");
  });

  test("unmount cancels the Runtime detail lookup", async () => {
    let lookupSignal: AbortSignal | undefined;
    const core = new TestCoreClient();
    core.runtime.getRuntime = async (_id, _options, signal) => {
      lookupSignal = signal;
      return new Promise(() => {});
    };
    const screen = renderScreen(CONSOLE_PATH, { core });

    await waitFor(() => lookupSignal !== undefined);
    screen.unmount();

    await waitFor(() => lookupSignal!.aborted);
  });
});

describe("Runtime invoke JSON console", () => {
  test("sends inline JSON with the fixed content type", async () => {
    const core = new TestCoreClient();
    core.runtime
      .setGetResponse({ agentRuntimeArn: RUNTIME_ARN } as GetAgentRuntimeResponse)
      .setInvokeResponse({
        statusCode: 200,
        contentType: "text/plain",
        body: responseBody(Buffer.from("ok")),
      });
    const screen = renderScreen(CONSOLE_PATH, { core });

    await waitForText(screen.lastFrame, "Enter JSON payload");
    expect(screen.lastFrame()!.split("\n")).not.toContain("JSON payload");
    const sessionId = displayedSessionId(screen.lastFrame());
    expect(sessionId).toMatch(UUID_PATTERN);
    await screen.write('{"prompt":"hello"}');
    await screen.press("return");
    await waitFor(() => invokeRequests(core).length === 1);

    expect(invokeRequests(core)[0]).toMatchObject({
      runtimeId: RUNTIME_ID,
      qualifier: QUALIFIER,
      contentType: "application/json",
      runtimeSessionId: sessionId,
    });
    expect(new TextDecoder().decode(invokeRequests(core)[0]!.payload)).toBe('{"prompt":"hello"}');
    await waitForText(screen.lastFrame, "complete · 2 bytes");
  });

  test("rejects invalid JSON locally without clearing the editor or invoking", async () => {
    const core = new TestCoreClient();
    core.runtime.setGetResponse({ agentRuntimeArn: RUNTIME_ARN } as GetAgentRuntimeResponse);
    const screen = renderScreen(CONSOLE_PATH, { core });

    await waitForText(screen.lastFrame, "Ready");
    await screen.write('{"prompt":');
    await screen.press("return");

    await waitForText(screen.lastFrame, "Enter a valid JSON payload");
    expect(screen.lastFrame()).toContain('{"prompt":');
    expect(invokeRequests(core)).toHaveLength(0);
  });

  test("Shift+Enter inserts JSON newlines without sending", async () => {
    const core = new TestCoreClient();
    core.runtime
      .setGetResponse({ agentRuntimeArn: RUNTIME_ARN } as GetAgentRuntimeResponse)
      .setInvokeResponse({
        statusCode: 200,
        contentType: "text/plain",
        body: responseBody(Buffer.from("ok")),
      });
    const screen = renderScreen(CONSOLE_PATH, { core });

    await waitForText(screen.lastFrame, "Ready");
    await screen.write("{");
    await screen.write("\x1b[13;2u");
    await screen.write('"prompt":"hello"');
    await screen.write("\x1b[13;2u");
    await screen.write("}");

    await waitForText(screen.lastFrame, '{\n"prompt":"hello"\n}');
    expect(invokeRequests(core)).toHaveLength(0);
    await screen.press("return");
    await waitFor(() => invokeRequests(core).length === 1);
    expect(new TextDecoder().decode(invokeRequests(core)[0]!.payload)).toBe(
      '{\n"prompt":"hello"\n}',
    );
  });

  test("edits JSON with cursor movement and backspace", async () => {
    const core = new TestCoreClient();
    core.runtime
      .setGetResponse({ agentRuntimeArn: RUNTIME_ARN } as GetAgentRuntimeResponse)
      .setInvokeResponse({
        statusCode: 200,
        contentType: "text/plain",
        body: responseBody(Buffer.from("ok")),
      });
    const screen = renderScreen(CONSOLE_PATH, { core });

    await waitForText(screen.lastFrame, "Ready");
    await screen.write('{"a":1}');
    await screen.press("left");
    await screen.press("left");
    await screen.write("2");
    await screen.press("right");
    await screen.write("\x7f");
    await screen.press("return");

    await waitFor(() => invokeRequests(core).length === 1);
    expect(new TextDecoder().decode(invokeRequests(core)[0]!.payload)).toBe('{"a":2}');
    await waitForText(screen.lastFrame, "Ready");
    await screen.write("\x7f");
    expect(screen.lastFrame()).toContain("Enter JSON payload");
  });

  test("keeps blank multiline rows inside the four-line editor", async () => {
    const core = new TestCoreClient();
    core.runtime.setGetResponse({ agentRuntimeArn: RUNTIME_ARN } as GetAgentRuntimeResponse);
    const screen = renderScreen(CONSOLE_PATH, { core });

    await waitForText(screen.lastFrame, "Ready");
    const initialStatusLine = screen
      .lastFrame()!
      .split("\n")
      .findIndex((line) => line.includes("Ready · Session ID"));

    for (let index = 0; index < 3; index++) await screen.write("\x1b[13;2u");

    const expandedLines = screen.lastFrame()!.split("\n");
    const dividerLines = expandedLines.flatMap((line, index) => (/^─+$/.test(line) ? [index] : []));
    expect(dividerLines.at(-2)! - dividerLines.at(-3)!).toBe(5);
    expect(expandedLines.findIndex((line) => line.includes("Ready · Session ID"))).toBe(
      initialStatusLine,
    );
    expect(screen.lastFrame()).not.toContain("…");

    await screen.write("\x1b[13;2u");
    expect(screen.lastFrame()).toContain("…");
  });

  test("keeps status and shortcut rows intact with a long target at narrow widths", async () => {
    const runtimeId = "RuntimeTuiMatrix_MatrixRuntime-vKVMPm4r8j";
    const core = new TestCoreClient();
    core.runtime.setGetResponse({
      agentRuntimeArn: `arn:aws:bedrock-agentcore:${REGION}:123456789012:runtime/${runtimeId}`,
    } as GetAgentRuntimeResponse);
    const screen = renderScreen(`/agentcore/runtime/invoke/${runtimeId}/${QUALIFIER}`, { core });

    await waitForText(screen.lastFrame, "Ready");
    await screen.resize(80, 24);
    expect(displayedSessionId(screen.lastFrame())).toMatch(UUID_PATTERN);
    expect(screen.lastFrame()).toContain(
      "[enter] send  [⇧↵] newline  [ctrl+t] target  [↑↓] scroll  [esc] back",
    );

    await screen.resize(60, 24);
    expect(displayedSessionId(screen.lastFrame())).toMatch(UUID_PATTERN);
    expect(screen.lastFrame()).toContain("[enter] send  [⇧↵] newline  [↑↓] scroll  [esc] back");
  });

  test("keeps the next JSON draft while the current response streams", async () => {
    const release = Promise.withResolvers<void>();
    const requests: RuntimeInvokeRequest[] = [];
    const core = new TestCoreClient();
    core.runtime.setGetResponse({ agentRuntimeArn: RUNTIME_ARN } as GetAgentRuntimeResponse);
    core.runtime.invokeRuntime = async (request) => {
      requests.push(request);
      return {
        statusCode: 200,
        contentType: "text/plain",
        body:
          requests.length === 1
            ? (async function* () {
                yield Buffer.from("partial");
                await release.promise;
              })()
            : responseBody(Buffer.from("done")),
      };
    };
    const screen = renderScreen(CONSOLE_PATH, { core });

    await waitForText(screen.lastFrame, "Ready");
    await screen.write('{"turn":1}');
    await screen.press("return");
    await waitForText(screen.lastFrame, "partial");
    await screen.write('{"turn":2}');
    await screen.press("return");
    expect(requests).toHaveLength(1);

    release.resolve();
    await waitForText(screen.lastFrame, "Ready");
    await screen.press("return");
    await waitFor(() => requests.length === 2);
    expect(new TextDecoder().decode(requests[1]!.payload)).toBe('{"turn":2}');
  });

  test("keeps settled response details out of streaming frames", async () => {
    const release = Promise.withResolvers<void>();
    const core = new TestCoreClient();
    core.runtime
      .setGetResponse({ agentRuntimeArn: RUNTIME_ARN } as GetAgentRuntimeResponse)
      .setInvokeResponse({
        statusCode: 200,
        contentType: "text/plain",
        runtimeSessionId: "returned-runtime",
        body: (async function* () {
          yield Buffer.from("partial");
          await release.promise;
          yield Buffer.from(" response");
        })(),
      });
    const screen = renderScreen(CONSOLE_PATH, { core });

    await waitForText(screen.lastFrame, "Ready");
    await screen.write("{}");
    const frameCount = screen.frames.length;
    await screen.press("return");
    await waitForText(screen.lastFrame, "partial");

    const streamingFrames = screen.frames
      .slice(frameCount)
      .filter((frame) => frame.includes("streaming…"));
    expect(streamingFrames.length).toBeGreaterThan(0);
    for (const frame of streamingFrames) {
      expect(frame).not.toContain("Session ID: returned-runtime");
      expect(frame).not.toContain("streaming ·");
    }

    release.resolve();
    await waitForText(screen.lastFrame, "complete · 16 bytes");
    expect(screen.lastFrame()).toContain("Session ID: returned-runtime");
  });

  test("removes trailing response newlines before settled metadata", async () => {
    const core = new TestCoreClient();
    core.runtime
      .setGetResponse({ agentRuntimeArn: RUNTIME_ARN } as GetAgentRuntimeResponse)
      .setInvokeResponse({
        statusCode: 200,
        contentType: "text/event-stream",
        runtimeSessionId: "returned-runtime",
        body: responseBody(Buffer.from("data: one\n\ndata: two\n\n")),
      });
    const screen = renderScreen(CONSOLE_PATH, { core });

    await waitForText(screen.lastFrame, "Ready");
    await screen.write("{}");
    await screen.press("return");
    await waitForText(screen.lastFrame, "complete · 22 bytes");

    const lines = screen.lastFrame()!.split("\n");
    const lastEvent = lines.findIndex((line) => line.includes("data: two"));
    const metadata = lines.findIndex((line) => line.includes("Session ID: returned-runtime"));
    expect(metadata).toBe(lastEvent + 1);
  });

  test.each([
    [
      "invalid UTF-8 text",
      "text/plain",
      Buffer.from([0xff]),
      "Invalid UTF-8 response; showing raw text.",
    ],
    [
      "invalid JSON",
      "application/json",
      Buffer.from("not-json"),
      "Invalid JSON response; showing raw text.",
    ],
  ])("explains %s responses", async (_case, contentType, body, note) => {
    const core = new TestCoreClient();
    core.runtime
      .setGetResponse({ agentRuntimeArn: RUNTIME_ARN } as GetAgentRuntimeResponse)
      .setInvokeResponse({
        statusCode: 200,
        contentType,
        body: responseBody(body),
      });
    const screen = renderScreen(CONSOLE_PATH, { core });

    await waitForText(screen.lastFrame, "Ready");
    await screen.write("{}");
    await screen.press("return");

    await waitForText(screen.lastFrame, note);
    expect(screen.lastFrame()).toContain(`complete · ${body.byteLength} bytes`);
  });

  test("shows failures that occur before a response starts", async () => {
    const core = new TestCoreClient();
    core.runtime.setGetResponse({ agentRuntimeArn: RUNTIME_ARN } as GetAgentRuntimeResponse);
    core.runtime.invokeRuntime = async () => {
      throw Object.assign(new Error("connection failed"), { name: "NetworkError" });
    };
    const screen = renderScreen(CONSOLE_PATH, { core });

    await waitForText(screen.lastFrame, "Ready");
    await screen.write("{}");
    await screen.press("return");

    await waitForText(screen.lastFrame, "NetworkError");
    await waitForText(screen.lastFrame, "connection failed");
    expect(screen.lastFrame()).toContain("failed · 0 bytes");
  });

  test("formats modeled AWS service errors with their diagnostics", async () => {
    const core = new TestCoreClient();
    core.runtime.setGetResponse({ agentRuntimeArn: RUNTIME_ARN } as GetAgentRuntimeResponse);
    const error = new ValidationException({
      message: "Runtime session ID must contain at least 33 characters",
      reason: "FieldValidationFailed",
      $metadata: { httpStatusCode: 400, requestId: "request-456" },
    });
    core.runtime.invokeRuntime = async () => {
      throw error;
    };
    const screen = renderScreen(CONSOLE_PATH, { core });

    await waitForText(screen.lastFrame, "Ready");
    await screen.write("{}");
    await screen.press("return");

    await waitForText(screen.lastFrame, "ValidationException · HTTP 400");
    expect(screen.lastFrame()).toContain("Runtime session ID must contain at least 33 characters");
    expect(screen.lastFrame()).toContain("Request ID: request-456");
  });

  test.each([
    ["string", "string failure", "string failure"],
    ["object", { code: "OBJECT_FAILURE" }, "[object Object]"],
  ])("surfaces a thrown %s", async (_case, failure, expected) => {
    const core = new TestCoreClient();
    core.runtime.setGetResponse({ agentRuntimeArn: RUNTIME_ARN } as GetAgentRuntimeResponse);
    core.runtime.invokeRuntime = async () => {
      throw failure;
    };
    const screen = renderScreen(CONSOLE_PATH, { core });

    await waitForText(screen.lastFrame, "Ready");
    await screen.write("{}");
    await screen.press("return");

    await waitForText(screen.lastFrame, expected);
    expect(screen.lastFrame()).toContain("failed · 0 bytes");
  });

  test("shows failures that occur while reading a response", async () => {
    const core = new TestCoreClient();
    core.runtime
      .setGetResponse({ agentRuntimeArn: RUNTIME_ARN } as GetAgentRuntimeResponse)
      .setInvokeResponse({
        statusCode: 200,
        contentType: "text/plain",
        body: (async function* () {
          yield Buffer.from("partial");
          throw Object.assign(new Error("stream failed"), { name: "StreamReadError" });
        })(),
      });
    const screen = renderScreen(CONSOLE_PATH, { core });

    await waitForText(screen.lastFrame, "Ready");
    await screen.write("{}");
    await screen.press("return");

    await waitForText(screen.lastFrame, "StreamReadError");
    await waitForText(screen.lastFrame, "stream failed");
    expect(screen.lastFrame()).toContain("partial");
    expect(screen.lastFrame()).toContain("failed · 7 bytes");
  });

  test("scrolls completed response history with the arrow keys", async () => {
    const response = Array.from({ length: 12 }, (_, index) => `response-line-${index}`).join("\n");
    const core = new TestCoreClient();
    core.runtime
      .setGetResponse({ agentRuntimeArn: RUNTIME_ARN } as GetAgentRuntimeResponse)
      .setInvokeResponse({
        statusCode: 200,
        contentType: "text/plain",
        body: responseBody(Buffer.from(response)),
      });
    const screen = renderScreen(CONSOLE_PATH, { core });
    await screen.resize(80, 16);

    await waitForText(screen.lastFrame, "Ready");
    await screen.write("{}");
    await screen.press("return");
    await waitForText(screen.lastFrame, "response-line-11");

    for (let index = 0; index < 8; index++) await screen.press("up");
    expect(screen.lastFrame()).toContain("response-line-3");
    for (let index = 0; index < 8; index++) await screen.press("down");
    expect(screen.lastFrame()).toContain("response-line-11");
  });

  test("starts from --session-id and adopts returned Runtime and MCP context", async () => {
    const requests: RuntimeInvokeRequest[] = [];
    const core = new TestCoreClient();
    core.runtime.setGetResponse({
      agentRuntimeArn: RUNTIME_ARN,
      protocolConfiguration: { serverProtocol: "MCP" },
    } as GetAgentRuntimeResponse);
    core.runtime.invokeRuntime = async (request) => {
      requests.push(request);
      return {
        statusCode: 200,
        contentType: "text/event-stream",
        runtimeSessionId: "returned-runtime",
        mcpSessionId: "returned-mcp",
        mcpProtocolVersion: "2025-06-18",
        body: responseBody(Buffer.from("data: done\n\n")),
      };
    };
    const initialSession = "cli-selected-session";
    const screen = renderScreen(CONSOLE_PATH, {
      core,
      withContext: (ctx) =>
        ctx.withValue(RuntimeInvokeLaunchContextKey, {
          runtimeId: RUNTIME_ID,
          runtimeSessionId: initialSession,
        }),
    });

    await waitForText(screen.lastFrame, `Session ID: ${initialSession}`);
    await screen.write('{"turn":1}');
    await screen.press("return");
    await waitForText(
      screen.lastFrame,
      "Ready · Session ID: returned-runtime · MCP session ID: returned-mcp",
    );
    await screen.write('{"turn":2}');
    await screen.press("return");
    await waitFor(() => requests.length === 2);

    expect(requests[0]!.runtimeSessionId).toBe(initialSession);
    expect(requests[0]!.mcpSessionId).toBeUndefined();
    expect(requests[0]!.mcpProtocolVersion).toBeUndefined();
    expect(requests[1]!.runtimeSessionId).toBe("returned-runtime");
    expect(requests[1]!.mcpSessionId).toBe("returned-mcp");
    expect(requests[1]!.mcpProtocolVersion).toBe("2025-06-18");
  });

  test("persists launch identity, authentication, and headers without exposing values", async () => {
    const token = "secret-bearer-token";
    const userId = "user-123";
    const requests: RuntimeInvokeRequest[] = [];
    const core = new TestCoreClient();
    core.runtime.setGetResponse({
      agentRuntimeArn: RUNTIME_ARN,
      authorizerConfiguration: { customJWTAuthorizer: {} },
      requestHeaderConfiguration: { requestHeaderAllowlist: ["X-Tenant"] },
    } as GetAgentRuntimeResponse);
    core.runtime.invokeRuntime = async (request) => {
      requests.push(request);
      return {
        statusCode: 200,
        contentType: "application/json",
        body: responseBody(Buffer.from('{"ok":true}')),
      };
    };
    const screen = renderScreen(CONSOLE_PATH, {
      core,
      withContext: (ctx) =>
        ctx.withValue(RuntimeInvokeLaunchContextKey, {
          runtimeId: RUNTIME_ID,
          runtimeUserId: userId,
          applicationHeaders: [["X-Tenant", "retail"]],
          bearerToken: token,
        }),
    });

    await waitForText(screen.lastFrame, "Context user/JWT/1h");
    expect(screen.lastFrame()).not.toContain(userId);
    expect(screen.lastFrame()).not.toContain(token);
    expect(screen.lastFrame()).not.toContain("retail");

    await screen.write('{"turn":1}');
    await screen.press("return");
    await waitForText(screen.lastFrame, "Ready");
    await screen.write('{"turn":2}');
    await screen.press("return");
    await waitFor(() => requests.length === 2);

    for (const request of requests) {
      expect(request).toMatchObject({
        runtimeUserId: userId,
        applicationHeaders: [["X-Tenant", "retail"]],
        bearerToken: token,
      });
    }
  });

  test("target switching clears transcript and target-specific sessions", async () => {
    const nextQualifier = "canary";
    const core = new TestCoreClient();
    core.runtime
      .setGetResponse({
        agentRuntimeArn: RUNTIME_ARN,
        protocolConfiguration: { serverProtocol: "MCP" },
        requestHeaderConfiguration: { requestHeaderAllowlist: ["X-Tenant"] },
      } as GetAgentRuntimeResponse)
      .setListResponse({ agentRuntimes: [runtime()] })
      .setListEndpointsResponse({
        runtimeEndpoints: [endpoint({ name: nextQualifier, id: nextQualifier })],
      })
      .setInvokeResponse({
        statusCode: 200,
        contentType: "text/plain",
        runtimeSessionId: "returned-runtime",
        mcpSessionId: "returned-mcp",
        mcpProtocolVersion: "2025-06-18",
        body: responseBody(Buffer.from("old response")),
      });
    const screen = renderScreen(CONSOLE_PATH, {
      core,
      withContext: (ctx) =>
        ctx.withValue(RuntimeInvokeLaunchContextKey, {
          runtimeId: RUNTIME_ID,
          runtimeUserId: "user-123",
          applicationHeaders: [["X-Tenant", "retail"]],
        }),
    });

    await waitForText(screen.lastFrame, "Ready");
    await screen.write('{"turn":1}');
    await screen.press("return");
    await waitForText(screen.lastFrame, "Ready · Session ID: returned-runtime");

    await screen.write("\x14");
    await waitForText(screen.lastFrame, "choose another Runtime");
    await screen.press("return");
    await waitForText(screen.lastFrame, nextQualifier);
    await screen.press("return");
    await waitForText(
      screen.lastFrame,
      `agentcore → runtime → invoke → ${RUNTIME_ID} → ${nextQualifier}`,
    );
    expect(screen.lastFrame()).not.toContain("old response");
    const nextSessionId = displayedSessionId(screen.lastFrame());
    expect(nextSessionId).toMatch(UUID_PATTERN);
    expect(nextSessionId).not.toBe("returned-runtime");
    expect(screen.lastFrame()).toContain("MCP session ID: Not set");

    core.runtime.setInvokeResponse({
      statusCode: 200,
      contentType: "text/plain",
      body: responseBody(Buffer.from("new response")),
    });
    await screen.write('{"turn":2}');
    await screen.press("return");
    await waitFor(() => invokeRequests(core).length === 2);
    expect(invokeRequests(core)[1]!.runtimeSessionId).toBe(nextSessionId);
    expect(invokeRequests(core)[1]!.mcpSessionId).toBeUndefined();
    expect(invokeRequests(core)[1]!.mcpProtocolVersion).toBeUndefined();
    expect(invokeRequests(core)[1]).toMatchObject({
      runtimeUserId: "user-123",
      applicationHeaders: [["X-Tenant", "retail"]],
    });
  });

  test("switching Runtimes clears launch identity, authentication, and headers", async () => {
    const nextRuntimeId = "runtime-next";
    const nextQualifier = "canary";
    const nextArn = RUNTIME_ARN.replace(RUNTIME_ID, nextRuntimeId);
    const core = new TestCoreClient();
    core.runtime
      .setGetResponse({
        agentRuntimeArn: RUNTIME_ARN,
        authorizerConfiguration: { customJWTAuthorizer: {} },
        requestHeaderConfiguration: { requestHeaderAllowlist: ["X-Tenant"] },
      } as GetAgentRuntimeResponse)
      .setListResponse({
        agentRuntimes: [
          runtime(),
          runtime({
            agentRuntimeId: nextRuntimeId,
            agentRuntimeName: "next-runtime",
            agentRuntimeArn: nextArn,
          }),
        ],
      })
      .setListEndpointsResponse({
        runtimeEndpoints: [endpoint({ name: nextQualifier, id: nextQualifier })],
      })
      .setInvokeResponse({
        statusCode: 200,
        contentType: "text/plain",
        body: responseBody(Buffer.from("ok")),
      });
    const screen = renderScreen(CONSOLE_PATH, {
      core,
      withContext: (ctx) =>
        ctx.withValue(RuntimeInvokeLaunchContextKey, {
          runtimeId: RUNTIME_ID,
          runtimeUserId: "user-123",
          applicationHeaders: [["X-Tenant", "retail"]],
          bearerToken: "secret-token",
        }),
    });

    await waitForText(screen.lastFrame, "Context user/JWT/1h");
    core.runtime.setGetResponse({ agentRuntimeArn: nextArn } as GetAgentRuntimeResponse);
    await screen.write("\x14");
    await waitForText(screen.lastFrame, "next-runtime");
    await screen.press("down");
    await screen.press("return");
    await waitForText(screen.lastFrame, nextQualifier);
    await screen.press("return");
    await waitForText(
      screen.lastFrame,
      `agentcore → runtime → invoke → ${nextRuntimeId} → ${nextQualifier}`,
    );
    expect(screen.lastFrame()).not.toContain("Context");

    await screen.write("{}");
    await screen.press("return");
    await waitFor(() => invokeRequests(core).length === 1);
    expect(invokeRequests(core)[0]!.runtimeUserId).toBe("default");
    expect(invokeRequests(core)[0]!.applicationHeaders).toBeUndefined();
    expect(invokeRequests(core)[0]!.bearerToken).toBeUndefined();
  });

  test("toggles a completed JSON response between raw and pretty text", async () => {
    const raw = '{"z":1,"nested":{"ok":true}}';
    const pretty = JSON.stringify(JSON.parse(raw), null, 2);
    const core = new TestCoreClient();
    core.runtime
      .setGetResponse({ agentRuntimeArn: RUNTIME_ARN } as GetAgentRuntimeResponse)
      .setInvokeResponse({
        statusCode: 200,
        contentType: "application/json",
        body: responseBody(Buffer.from(raw)),
      });
    const screen = renderScreen(CONSOLE_PATH, { core });

    await waitForText(screen.lastFrame, "Ready");
    await screen.write("{}");
    await screen.press("return");
    await waitForText(screen.lastFrame, raw);
    await waitForText(screen.lastFrame, "Ready");

    await screen.write("\x16");
    await waitForText(screen.lastFrame, pretty);
    await screen.write("\x16");
    await waitForText(screen.lastFrame, raw);
  });

  test("rejects binary console responses before consuming their bodies", async () => {
    let iterations = 0;
    const core = new TestCoreClient();
    core.runtime
      .setGetResponse({ agentRuntimeArn: RUNTIME_ARN } as GetAgentRuntimeResponse)
      .setInvokeResponse({
        statusCode: 200,
        contentType: "application/octet-stream",
        body: (async function* () {
          iterations++;
          yield Buffer.from([0, 255]);
        })(),
      });
    const screen = renderScreen(CONSOLE_PATH, { core });

    await waitForText(screen.lastFrame, "Ready");
    await screen.write("{}");
    await screen.press("return");

    await waitForText(
      screen.lastFrame,
      "Binary or unknown responses require headless invoke with --output-file.",
    );
    expect(iterations).toBe(0);
  });

  test("reports a missing bearer token for CUSTOM_JWT Runtimes", async () => {
    const core = new TestCoreClient();
    core.runtime.setGetResponse({
      agentRuntimeArn: RUNTIME_ARN,
      authorizerConfiguration: { customJWTAuthorizer: {} },
    } as GetAgentRuntimeResponse);
    const screen = renderScreen(CONSOLE_PATH, { core });

    await waitForText(screen.lastFrame, "Ready");
    await screen.write("{}");
    await screen.press("return");

    await waitForText(screen.lastFrame, "CUSTOM_JWT Runtime requires --bearer-token");
    expect(invokeRequests(core)).toHaveLength(0);
  });

  test("Esc interrupts a response stream, preserves partial text, and rejects its sessions", async () => {
    const stop = Promise.withResolvers<void>();
    let signal: AbortSignal | undefined;
    const core = new TestCoreClient();
    core.runtime.setGetResponse({ agentRuntimeArn: RUNTIME_ARN } as GetAgentRuntimeResponse);
    core.runtime.invokeRuntime = async (_request, _options, nextSignal) => {
      signal = nextSignal;
      return {
        statusCode: 200,
        contentType: "text/event-stream",
        runtimeSessionId: "interrupted-runtime",
        mcpSessionId: "interrupted-mcp",
        body: (async function* () {
          yield Buffer.from("data: partial\n");
          await stop.promise;
        })(),
      };
    };
    const screen = renderScreen(CONSOLE_PATH, { core });

    try {
      await waitForText(screen.lastFrame, "Ready");
      const initialSessionId = displayedSessionId(screen.lastFrame());
      expect(initialSessionId).toMatch(UUID_PATTERN);
      await screen.write("{}");
      await screen.press("return");
      await waitForText(screen.lastFrame, "data: partial");

      await screen.press("escape");
      expect(signal?.aborted).toBe(true);
      stop.reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
      await waitForText(screen.lastFrame, "interrupted · 14 bytes");
      expect(screen.lastFrame()).toContain("data: partial");
      expect(screen.lastFrame()).toContain(`Ready · Session ID: ${initialSessionId}`);
      expect(
        screen
          .lastFrame()!
          .split("\n")
          .find((line) => line.includes("Ready · Session ID")),
      ).not.toContain("MCP session ID");
    } finally {
      stop.resolve();
    }
  });
});
