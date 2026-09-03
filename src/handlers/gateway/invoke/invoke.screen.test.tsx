import { afterEach, describe, expect, test } from "bun:test";
import type { GatewaySummary, GetGatewayResponse } from "@aws-sdk/client-bedrock-agentcore-control";
import {
  cleanupScreens,
  renderScreen,
  TestCoreClient,
  waitFor,
  waitForText,
} from "../../../testing";
import type { GatewayInvokeRequest } from "../types";
import { GatewayInvokeLaunchContextKey } from "./launchContext";

const GATEWAY_ID = "gateway-123";
const GATEWAY_URL = "https://gateway-123.gateway.example.test/mcp";
const CONSOLE_PATH = `/agentcore/gateway/invoke/${GATEWAY_ID}`;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(cleanupScreens);

function gatewaySummary(overrides: Partial<GatewaySummary> = {}): GatewaySummary {
  return {
    gatewayId: GATEWAY_ID,
    name: "checkout-gateway",
    status: "READY",
    authorizerType: "NONE",
    protocolType: "MCP",
    createdAt: new Date("2026-08-01T01:02:03.000Z"),
    updatedAt: new Date("2026-08-02T03:04:05.000Z"),
    ...overrides,
  };
}

function gatewayDetail(overrides: Partial<GetGatewayResponse> = {}): GetGatewayResponse {
  return {
    gatewayId: GATEWAY_ID,
    gatewayUrl: GATEWAY_URL,
    name: "checkout-gateway",
    status: "READY",
    authorizerType: "NONE",
    protocolType: "MCP",
    ...overrides,
  } as GetGatewayResponse;
}

function responseBody(...chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  return (async function* () {
    yield* chunks;
  })();
}

function invokeRequests(core: TestCoreClient): GatewayInvokeRequest[] {
  return core.gateway.calls
    .filter((call) => call.method === "invokeGateway")
    .map((call) => call.args[0] as GatewayInvokeRequest);
}

function displayedSessionId(frame: string | undefined): string | undefined {
  return frame?.match(/Runtime session ID: ([^ ·\n]+)/)?.[1];
}

describe("Gateway invoke routing", () => {
  test("selects a Gateway before opening the JSON console", async () => {
    const core = new TestCoreClient();
    core.gateway.setListResponse({ items: [gatewaySummary()] }).setGetResponse(gatewayDetail());
    const screen = renderScreen("/agentcore/gateway/invoke", { core });

    await waitForText(screen.lastFrame, "checkout-gateway");
    await screen.press("return");

    await waitForText(screen.lastFrame, `agentcore → gateway → invoke → ${GATEWAY_ID}`);
    await waitForText(screen.lastFrame, "Enter JSON payload");
    expect(screen.lastFrame()).toContain("Path: /mcp (Gateway URL)");
    expect(displayedSessionId(screen.lastFrame())).toMatch(UUID_PATTERN);
  });

  test("shows Gateway lookup failures and aborts lookup on unmount", async () => {
    let signal: AbortSignal | undefined;
    const core = new TestCoreClient();
    core.gateway.getGateway = async (_id, _options, nextSignal) => {
      signal = nextSignal;
      throw Object.assign(new Error("not authorized for this Gateway"), {
        name: "AccessDeniedException",
      });
    };
    const errorScreen = renderScreen(CONSOLE_PATH, { core });

    await waitForText(errorScreen.lastFrame, "AccessDeniedException");
    await waitForText(errorScreen.lastFrame, "not authorized for this Gateway");
    expect(signal?.aborted).toBe(false);
    errorScreen.unmount();

    const pendingCore = new TestCoreClient();
    pendingCore.gateway.getGateway = async (_id, _options, nextSignal) => {
      signal = nextSignal;
      return new Promise(() => {});
    };
    const pendingScreen = renderScreen(CONSOLE_PATH, { core: pendingCore });
    await waitFor(() => signal !== undefined && !signal.aborted);
    pendingScreen.unmount();
    await waitFor(() => signal!.aborted);
  });

  test("idle Escape returns through the invoke picker to the Gateway menu", async () => {
    const core = new TestCoreClient();
    core.gateway.setGetResponse(gatewayDetail()).setListResponse({ items: [gatewaySummary()] });
    const screen = renderScreen(CONSOLE_PATH, { core });

    await waitForText(screen.lastFrame, "Ready");
    await screen.press("escape");
    await waitForText(screen.lastFrame, "choose a Gateway to invoke");
    await waitForText(screen.lastFrame, "checkout-gateway");
    expect(screen.lastFrame()).toContain("checkout-gateway");

    await screen.press("escape");
    await waitForText(screen.lastFrame, "manage AgentCore Gateways");
  });
});

describe("Gateway invoke JSON console", () => {
  test("sends POST JSON with broad response acceptance and a generated session", async () => {
    const core = new TestCoreClient();
    core.gateway.setGetResponse(gatewayDetail()).setInvokeResponse({
      statusCode: 200,
      contentType: "text/plain",
      body: responseBody(Buffer.from("ok")),
    });
    const screen = renderScreen(CONSOLE_PATH, { core });

    await waitForText(screen.lastFrame, "Enter JSON payload");
    const sessionId = displayedSessionId(screen.lastFrame());
    expect(sessionId).toMatch(UUID_PATTERN);
    await screen.write('{"prompt":"hello"}');
    await screen.press("return");
    await waitFor(() => invokeRequests(core).length === 1);

    expect(invokeRequests(core)[0]).toMatchObject({
      gatewayId: GATEWAY_ID,
      url: GATEWAY_URL,
      method: "POST",
      authorizerType: "NONE",
      contentType: "application/json",
      accept: "application/json, text/event-stream, */*;q=0.1",
      runtimeSessionId: sessionId,
    });
    expect(new TextDecoder().decode(invokeRequests(core)[0]!.payload)).toBe('{"prompt":"hello"}');
    await waitForText(screen.lastFrame, "complete · 2 bytes");
  });

  test.each(["NONE", "AWS_IAM", "AUTHENTICATE_ONLY"] as const)(
    "uses %s ingress authentication without a bearer token",
    async (authorizerType) => {
      const core = new TestCoreClient();
      core.gateway.setGetResponse(gatewayDetail({ authorizerType })).setInvokeResponse({
        statusCode: 200,
        contentType: "text/plain",
        body: responseBody(Buffer.from("ok")),
      });
      const screen = renderScreen(CONSOLE_PATH, { core });

      await waitForText(screen.lastFrame, `Auth: ${authorizerType}`);
      await screen.write("{}");
      await screen.press("return");
      await waitFor(() => invokeRequests(core).length === 1);

      expect(invokeRequests(core)[0]).toMatchObject({ authorizerType });
      expect(invokeRequests(core)[0]!.bearerToken).toBeUndefined();
    },
  );

  test("rejects invalid JSON without clearing the editor or invoking", async () => {
    const core = new TestCoreClient();
    core.gateway.setGetResponse(gatewayDetail());
    const screen = renderScreen(CONSOLE_PATH, { core });

    await waitForText(screen.lastFrame, "Ready");
    await screen.write('{"prompt":');
    await screen.press("return");

    await waitForText(screen.lastFrame, "Enter a valid JSON payload");
    expect(screen.lastFrame()).toContain('{"prompt":');
    expect(invokeRequests(core)).toHaveLength(0);
  });

  test("keeps the draft out of history when request normalization fails", async () => {
    const core = new TestCoreClient();
    core.gateway.setGetResponse(gatewayDetail());
    const screen = renderScreen(CONSOLE_PATH, {
      core,
      withContext: (ctx) =>
        ctx.withValue(GatewayInvokeLaunchContextKey, {
          gatewayId: GATEWAY_ID,
          path: "https://evil.example/path",
        }),
    });

    await waitForText(screen.lastFrame, "Ready");
    await screen.write('{"important":"draft"}');
    await screen.press("return");

    await waitForText(screen.lastFrame, "--path must be relative to the Gateway");
    expect(screen.lastFrame()).toContain('{"important":"draft"}');
    expect(screen.lastFrame()).not.toContain("Request\n");
    expect(invokeRequests(core)).toHaveLength(0);
  });

  test("seeds path, sessions, authentication, and headers without exposing secrets", async () => {
    const token = "secret-bearer-token";
    const core = new TestCoreClient();
    core.gateway.setGetResponse(gatewayDetail({ authorizerType: "CUSTOM_JWT" })).setInvokeResponse({
      statusCode: 200,
      contentType: "application/json",
      body: responseBody(Buffer.from('{"ok":true}')),
    });
    const screen = renderScreen(CONSOLE_PATH, {
      core,
      withContext: (ctx) =>
        ctx.withValue(GatewayInvokeLaunchContextKey, {
          gatewayId: GATEWAY_ID,
          path: "runtime/invocations",
          runtimeSessionId: "seeded-runtime",
          mcpSessionId: "seeded-mcp",
          mcpProtocolVersion: "2025-06-18",
          applicationHeaders: [["X-Tenant", "retail"]],
          bearerToken: token,
        }),
    });

    await waitForText(screen.lastFrame, "Path: runtime/invocations");
    expect(screen.lastFrame()).toContain("Runtime session ID: seeded-runtime");
    expect(screen.lastFrame()).toContain("Context: JWT/1h");
    expect(screen.lastFrame()).not.toContain(token);
    expect(screen.lastFrame()).not.toContain("retail");

    await screen.write("{}");
    await screen.press("return");
    await waitFor(() => invokeRequests(core).length === 1);
    expect(invokeRequests(core)[0]).toMatchObject({
      url: "https://gateway-123.gateway.example.test/runtime/invocations",
      runtimeSessionId: "seeded-runtime",
      mcpSessionId: "seeded-mcp",
      mcpProtocolVersion: "2025-06-18",
      applicationHeaders: [["X-Tenant", "retail"]],
      bearerToken: token,
    });
  });

  test("proactively blocks CUSTOM_JWT submission without a bearer token", async () => {
    const core = new TestCoreClient();
    core.gateway.setGetResponse(gatewayDetail({ authorizerType: "CUSTOM_JWT" }));
    const screen = renderScreen(CONSOLE_PATH, { core });

    await waitForText(screen.lastFrame, "CUSTOM_JWT Gateway requires --bearer-token");
    await screen.write("{}");
    await screen.press("return");

    expect(invokeRequests(core)).toHaveLength(0);
    expect(screen.lastFrame()).toContain("{}");
    expect(screen.lastFrame()).toContain("[ctl+p] path");
    expect(screen.lastFrame()).toContain("[ctl+t] gateway");
  });

  test("blocks a non-READY Gateway with its current status", async () => {
    const core = new TestCoreClient();
    core.gateway.setGetResponse(gatewayDetail({ status: "FAILED" }));
    const screen = renderScreen(CONSOLE_PATH, { core });

    await waitForText(screen.lastFrame, "Gateway is FAILED; invocation requires READY");
    await screen.write("{}");
    await screen.press("return");

    expect(invokeRequests(core)).toHaveLength(0);
  });

  test("edits and cancels paths while preserving the JSON draft", async () => {
    const core = new TestCoreClient();
    core.gateway.setGetResponse(gatewayDetail()).setInvokeResponse({
      statusCode: 200,
      contentType: "text/plain",
      body: responseBody(Buffer.from("ok")),
    });
    const screen = renderScreen(CONSOLE_PATH, { core });

    await waitForText(screen.lastFrame, "Ready");
    const initialSession = displayedSessionId(screen.lastFrame());
    await screen.write('{"turn":1}');
    await screen.write("\x10");
    await waitForText(screen.lastFrame, "Edit path");
    expect(screen.lastFrame()).toContain("Ready · Runtime session ID:");
    expect(screen.lastFrame()).toContain('{"turn":1}');
    expect(screen.lastFrame()).toContain("[enter] save");
    expect(screen.lastFrame()).not.toContain("→ path →");
    await screen.write("ignored/path");
    await screen.press("escape");
    await waitForText(screen.lastFrame, "Path: /mcp (Gateway URL)");
    expect(screen.lastFrame()).toContain('{"turn":1}');
    expect(displayedSessionId(screen.lastFrame())).toBe(initialSession);
  });

  test("clears a seeded path back to the exact Gateway URL", async () => {
    const seededPath = "runtime/invocations";
    const core = new TestCoreClient();
    core.gateway.setGetResponse(gatewayDetail());
    const screen = renderScreen(CONSOLE_PATH, {
      core,
      withContext: (ctx) =>
        ctx.withValue(GatewayInvokeLaunchContextKey, {
          gatewayId: GATEWAY_ID,
          path: seededPath,
          runtimeSessionId: "seeded-session",
        }),
    });

    await waitForText(screen.lastFrame, `Path: ${seededPath}`);
    await screen.write("\x10");
    for (let index = 0; index < seededPath.length; index++) {
      await screen.write("\x7f");
    }
    await screen.press("return");
    await waitForText(screen.lastFrame, "[enter] send");

    await waitForText(screen.lastFrame, "Path: /mcp (Gateway URL)");
    expect(displayedSessionId(screen.lastFrame())).toMatch(UUID_PATTERN);
    expect(displayedSessionId(screen.lastFrame())).not.toBe("seeded-session");
  });

  test("path changes clear transcript and returned sessions but retain Gateway context", async () => {
    const core = new TestCoreClient();
    core.gateway.setGetResponse(gatewayDetail({ authorizerType: "CUSTOM_JWT" })).setInvokeResponse({
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
        ctx.withValue(GatewayInvokeLaunchContextKey, {
          gatewayId: GATEWAY_ID,
          bearerToken: "secret-token",
          applicationHeaders: [["X-Tenant", "retail"]],
        }),
    });

    await waitForText(screen.lastFrame, "Ready");
    await screen.write('{"turn":1}');
    await screen.press("return");
    await waitForText(screen.lastFrame, "Runtime session ID: returned-runtime");
    await screen.write('{"turn":2}');

    await screen.write("\x10");
    await screen.write("new/path");
    await screen.press("return");
    await waitForText(screen.lastFrame, "Path: new/path");

    expect(screen.lastFrame()).not.toContain("old response");
    expect(screen.lastFrame()).not.toContain("returned-mcp");
    expect(screen.lastFrame()).toContain('{"turn":2}');
    expect(screen.lastFrame()).toContain("Context: JWT/1h");
    expect(displayedSessionId(screen.lastFrame())).toMatch(UUID_PATTERN);
  });

  test("switching Gateways clears path, draft, transcript, sessions, and request context", async () => {
    const nextGatewayId = "gateway-next";
    const core = new TestCoreClient();
    core.gateway
      .setGetResponse(gatewayDetail({ authorizerType: "CUSTOM_JWT" }))
      .setListResponse({
        items: [
          gatewaySummary(),
          gatewaySummary({
            gatewayId: nextGatewayId,
            name: "next-gateway",
            authorizerType: "NONE",
          }),
        ],
      })
      .setInvokeResponse({
        statusCode: 200,
        contentType: "text/plain",
        runtimeSessionId: "returned-runtime",
        mcpSessionId: "returned-mcp",
        body: responseBody(Buffer.from("old response")),
      });
    const screen = renderScreen(CONSOLE_PATH, {
      core,
      withContext: (ctx) =>
        ctx.withValue(GatewayInvokeLaunchContextKey, {
          gatewayId: GATEWAY_ID,
          path: "old/path",
          bearerToken: "secret-token",
          applicationHeaders: [["X-Tenant", "retail"]],
        }),
    });

    await waitForText(screen.lastFrame, "Ready");
    await screen.write('{"turn":1}');
    await screen.press("return");
    await waitForText(screen.lastFrame, "old response");
    await screen.write('{"draft":true}');
    core.gateway.setGetResponse(
      gatewayDetail({
        gatewayId: nextGatewayId,
        name: "next-gateway",
        authorizerType: "NONE",
      }),
    );

    await screen.write("\x14");
    await waitForText(screen.lastFrame, "next-gateway");
    await screen.press("down");
    await screen.press("return");
    await waitForText(screen.lastFrame, `agentcore → gateway → invoke → ${nextGatewayId}`);
    await waitForText(screen.lastFrame, "Ready");

    expect(screen.lastFrame()).toContain("Path: /mcp (Gateway URL)");
    expect(screen.lastFrame()).not.toContain("old response");
    expect(screen.lastFrame()).not.toContain('{"draft":true}');
    expect(screen.lastFrame()).not.toContain("returned-mcp");
    expect(screen.lastFrame()).not.toContain("Context:");
    expect(displayedSessionId(screen.lastFrame())).toMatch(UUID_PATTERN);
  });

  test("cancelling Gateway switching preserves the complete console state", async () => {
    const core = new TestCoreClient();
    core.gateway
      .setGetResponse(gatewayDetail({ authorizerType: "CUSTOM_JWT" }))
      .setListResponse({ items: [gatewaySummary()] });
    const screen = renderScreen(CONSOLE_PATH, {
      core,
      withContext: (ctx) =>
        ctx.withValue(GatewayInvokeLaunchContextKey, {
          gatewayId: GATEWAY_ID,
          path: "kept/path",
          runtimeSessionId: "kept-session",
          bearerToken: "secret-token",
          applicationHeaders: [["X-Tenant", "retail"]],
        }),
    });

    await waitForText(screen.lastFrame, "Ready");
    await screen.write('{"kept":"draft"}');
    await screen.write("\x14");
    await waitForText(screen.lastFrame, "choose another Gateway");
    await screen.press("escape");

    await waitForText(screen.lastFrame, "Path: kept/path");
    expect(screen.lastFrame()).toContain("Runtime session ID: kept-session");
    expect(screen.lastFrame()).toContain('{"kept":"draft"}');
    expect(screen.lastFrame()).toContain("Context: JWT/1h");
  });

  test("renders streamed chunks before completion and adopts returned sessions afterward", async () => {
    const release = Promise.withResolvers<void>();
    const core = new TestCoreClient();
    core.gateway.setGetResponse(gatewayDetail()).setInvokeResponse({
      statusCode: 200,
      contentType: "text/event-stream",
      runtimeSessionId: "returned-runtime",
      mcpSessionId: "returned-mcp",
      mcpProtocolVersion: "2025-06-18",
      body: (async function* () {
        yield Buffer.from("data: first\n");
        await release.promise;
        yield Buffer.from("data: second\n");
      })(),
    });
    const screen = renderScreen(CONSOLE_PATH, { core });

    await waitForText(screen.lastFrame, "Ready");
    const initialSession = displayedSessionId(screen.lastFrame());
    await screen.write("{}");
    await screen.press("return");
    await waitForText(screen.lastFrame, "data: first");

    expect(screen.lastFrame()).toContain("streaming");
    expect(screen.lastFrame()).not.toContain("returned-runtime");
    release.resolve();
    await waitForText(screen.lastFrame, "data: second");
    await waitForText(screen.lastFrame, "complete · 25 bytes");
    expect(screen.lastFrame()).toContain("Runtime session ID: returned-runtime");
    expect(screen.lastFrame()).toContain("MCP session ID: returned-mcp");
    expect(initialSession).not.toBe("returned-runtime");

    core.gateway.setInvokeResponse({
      statusCode: 200,
      contentType: "text/plain",
      body: responseBody(Buffer.from("continued")),
    });
    await screen.write('{"turn":2}');
    await screen.press("return");
    await waitFor(() => invokeRequests(core).length === 2);
    expect(invokeRequests(core)[1]).toMatchObject({
      runtimeSessionId: "returned-runtime",
      mcpSessionId: "returned-mcp",
      mcpProtocolVersion: "2025-06-18",
    });
  });

  test("preserves non-2xx bodies and marks the exchange failed", async () => {
    const core = new TestCoreClient();
    core.gateway.setGetResponse(gatewayDetail()).setInvokeResponse({
      statusCode: 422,
      contentType: "application/problem+json",
      requestId: "request-422",
      runtimeSessionId: "error-runtime",
      mcpSessionId: "error-mcp",
      mcpProtocolVersion: "2025-06-18",
      body: responseBody(Buffer.from('{"message":"invalid"}')),
    });
    const screen = renderScreen(CONSOLE_PATH, { core });

    await waitForText(screen.lastFrame, "Ready");
    await screen.write("{}");
    await screen.press("return");

    await waitForText(screen.lastFrame, '{"message":"invalid"}');
    expect(screen.lastFrame()).toContain("Response · 422 · application/problem+json");
    expect(screen.lastFrame()).toContain("request-422");
    expect(screen.lastFrame()).toContain("HTTP 422");
    expect(screen.lastFrame()).toContain("failed · 21 bytes");

    core.gateway.setInvokeResponse({
      statusCode: 200,
      contentType: "text/plain",
      body: responseBody(Buffer.from("continued")),
    });
    await screen.write('{"turn":2}');
    await screen.press("return");
    await waitFor(() => invokeRequests(core).length === 2);
    expect(invokeRequests(core)[1]).toMatchObject({
      runtimeSessionId: "error-runtime",
      mcpSessionId: "error-mcp",
      mcpProtocolVersion: "2025-06-18",
    });
  });

  test("preserves manual redirect bodies and marks the exchange failed", async () => {
    const core = new TestCoreClient();
    core.gateway.setGetResponse(gatewayDetail()).setInvokeResponse({
      statusCode: 307,
      contentType: "text/plain",
      body: responseBody(Buffer.from("Temporary Redirect")),
    });
    const screen = renderScreen(CONSOLE_PATH, { core });

    await waitForText(screen.lastFrame, "Ready");
    await screen.write("{}");
    await screen.press("return");

    await waitForText(screen.lastFrame, "Temporary Redirect");
    expect(screen.lastFrame()).toContain("Response · 307 · text/plain");
    expect(screen.lastFrame()).toContain("HTTP 307");
    expect(screen.lastFrame()).toContain("failed · 18 bytes");
  });

  test("toggles completed JSON between raw and pretty text", async () => {
    const raw = '{"z":1,"nested":{"ok":true}}';
    const pretty = JSON.stringify(JSON.parse(raw), null, 2);
    const core = new TestCoreClient();
    core.gateway.setGetResponse(gatewayDetail()).setInvokeResponse({
      statusCode: 200,
      contentType: "application/json",
      body: responseBody(Buffer.from(raw)),
    });
    const screen = renderScreen(CONSOLE_PATH, { core });

    await waitForText(screen.lastFrame, "Ready");
    await screen.write("{}");
    await screen.press("return");
    await waitForText(screen.lastFrame, raw);
    await screen.write("\x16");
    await waitForText(screen.lastFrame, pretty);
    await screen.write("\x16");
    await waitForText(screen.lastFrame, raw);
  });

  test.each([
    [
      "invalid UTF-8 text",
      "text/plain",
      Buffer.from([0xff]),
      "Non-renderable responses require headless invoke with --output-file.",
    ],
    [
      "invalid JSON",
      "application/json",
      Buffer.from("{not-json"),
      "Invalid JSON response; showing raw text.",
    ],
  ])("explains %s responses", async (_case, contentType, bytes, expected) => {
    const core = new TestCoreClient();
    core.gateway.setGetResponse(gatewayDetail()).setInvokeResponse({
      statusCode: 200,
      contentType,
      body: responseBody(bytes),
    });
    const screen = renderScreen(CONSOLE_PATH, { core });

    await waitForText(screen.lastFrame, "Ready");
    await screen.write("{}");
    await screen.press("return");

    await waitForText(screen.lastFrame, expected);
    if (_case === "invalid UTF-8 text") {
      expect(screen.lastFrame()).toContain(`failed · ${bytes.byteLength} bytes`);
      expect(screen.lastFrame()).not.toContain("�");
    } else {
      expect(screen.lastFrame()).toContain(`complete · ${bytes.byteLength} bytes`);
    }
  });

  test("preserves partial text when response iteration fails", async () => {
    const core = new TestCoreClient();
    core.gateway.setGetResponse(gatewayDetail()).setInvokeResponse({
      statusCode: 200,
      contentType: "text/plain",
      body: (async function* () {
        yield Buffer.from("partial");
        throw Object.assign(new Error("stream failed"), {
          name: "StreamReadError",
        });
      })(),
    });
    const screen = renderScreen(CONSOLE_PATH, { core });

    await waitForText(screen.lastFrame, "Ready");
    await screen.write("{}");
    await screen.press("return");

    await waitForText(screen.lastFrame, "StreamReadError");
    expect(screen.lastFrame()).toContain("stream failed");
    expect(screen.lastFrame()).toContain("partial");
    expect(screen.lastFrame()).toContain("failed · 7 bytes");
  });

  test.each([204, 205])(
    "accepts HTTP %s without a content type or response body",
    async (statusCode) => {
      const core = new TestCoreClient();
      core.gateway.setGetResponse(gatewayDetail()).setInvokeResponse({
        statusCode,
        contentType: "",
        body: responseBody(),
      });
      const screen = renderScreen(CONSOLE_PATH, { core });

      await waitForText(screen.lastFrame, "Ready");
      await screen.write("{}");
      await screen.press("return");

      await waitForText(screen.lastFrame, "complete · 0 bytes");
      expect(screen.lastFrame()).toContain(`Response · ${statusCode} · -`);
      expect(screen.lastFrame()).not.toContain("Binary or unknown responses");
    },
  );

  test("rejects binary console responses without consuming their bodies", async () => {
    let iterations = 0;
    const core = new TestCoreClient();
    core.gateway.setGetResponse(gatewayDetail()).setInvokeResponse({
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

  test("Escape interrupts streaming and preserves partial output without adopting sessions", async () => {
    let signal: AbortSignal | undefined;
    const core = new TestCoreClient();
    core.gateway.setGetResponse(gatewayDetail());
    core.gateway.invokeGateway = async (_request, _options, nextSignal) => {
      signal = nextSignal;
      return {
        statusCode: 200,
        contentType: "text/event-stream",
        runtimeSessionId: "interrupted-runtime",
        mcpSessionId: "interrupted-mcp",
        body: (async function* () {
          yield Buffer.from("data: partial\n");
          await new Promise<void>((_resolve, reject) => {
            nextSignal?.addEventListener(
              "abort",
              () =>
                reject(
                  Object.assign(new Error("The operation was aborted"), {
                    name: "AbortError",
                  }),
                ),
              { once: true },
            );
          });
        })(),
      };
    };
    const screen = renderScreen(CONSOLE_PATH, { core });

    await waitForText(screen.lastFrame, "Ready");
    const initialSession = displayedSessionId(screen.lastFrame());
    await screen.write("{}");
    await screen.press("return");
    await waitForText(screen.lastFrame, "data: partial");
    await screen.press("escape");

    await waitFor(() => signal?.aborted === true);
    await waitForText(screen.lastFrame, "interrupted · 14 bytes");
    expect(screen.lastFrame()).toContain("data: partial");
    const readyLine = screen
      .lastFrame()!
      .split("\n")
      .find((line) => line.includes("Ready · Runtime session ID:"));
    expect(readyLine).toContain(`Runtime session ID: ${initialSession}`);
    expect(readyLine).not.toContain("interrupted-mcp");
  });

  test("keeps status and shortcuts stable at narrow terminal widths", async () => {
    const core = new TestCoreClient();
    core.gateway.setGetResponse(gatewayDetail());
    const screen = renderScreen(CONSOLE_PATH, { core });

    await waitForText(screen.lastFrame, "Ready");
    await screen.resize(80, 24);
    expect(displayedSessionId(screen.lastFrame())).toMatch(UUID_PATTERN);
    expect(screen.lastFrame()).toContain("[ctl+p] path");

    await screen.resize(60, 24);
    expect(screen.lastFrame()).toContain("[enter] send");
    expect(screen.lastFrame()).toContain("[esc] back");
  });

  test("horizontally windows long single-line JSON without corrupting status rows", async () => {
    const core = new TestCoreClient();
    core.gateway.setGetResponse(gatewayDetail());
    const screen = renderScreen(CONSOLE_PATH, { core });
    await screen.resize(100, 24);

    await waitForText(screen.lastFrame, "Ready");
    await screen.write(
      JSON.stringify({
        model: "provider/model",
        messages: [{ role: "user", content: "x".repeat(180) }],
      }),
    );

    const frame = screen.lastFrame()!;
    expect(frame.split("\n")).toHaveLength(24);
    expect(frame).toContain("Ready · Runtime session ID:");
    expect(frame).toContain("Auth: NONE");
    expect(frame).not.toContain("NONEon ID");
  });

  test("scrolls completed response history", async () => {
    const response = Array.from({ length: 12 }, (_, index) => `response-line-${index}`).join("\n");
    const core = new TestCoreClient();
    core.gateway.setGetResponse(gatewayDetail()).setInvokeResponse({
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
});
