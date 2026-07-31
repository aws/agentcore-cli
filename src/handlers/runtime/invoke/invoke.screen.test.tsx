import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
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

const REGION = "us-east-1";
const RUNTIME_ID = "runtime-123";
const QUALIFIER = "prod";
const RUNTIME_ARN = `arn:aws:bedrock-agentcore:${REGION}:123456789012:runtime/${RUNTIME_ID}`;
const CONSOLE_PATH = `/agentcore/runtime/invoke/${RUNTIME_ID}/${QUALIFIER}`;
const RUNTIME_USER_ID = "preserved-user";
const APPLICATION_HEADER = "X-Tenant: secret-header";

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

async function* splitUtf8(text: string, splitAt: number): AsyncIterable<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  yield bytes.slice(0, splitAt);
  yield bytes.slice(splitAt);
}

function responseBody(...chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  return (async function* () {
    yield* chunks;
  })();
}

type InvokeScreen = ReturnType<typeof renderScreen>;

async function moveDown(screen: InvokeScreen, count: number) {
  for (let index = 0; index < count; index++) await screen.press("down");
}

async function editText(screen: InvokeScreen, down: number, value: string) {
  await moveDown(screen, down);
  await screen.press("return");
  await screen.write(value);
  await screen.press("return");
}

async function editCustom(screen: InvokeScreen, down: number, choice: number, value: string) {
  await moveDown(screen, down);
  await screen.press("return");
  await moveDown(screen, choice);
  await screen.press("return");
  await screen.write(value);
  await screen.press("return");
}

async function configureRuntimeScopedOptions(screen: InvokeScreen, token: string) {
  await screen.write("\x0f");
  await waitForText(screen.lastFrame, "Request options");
  await editText(screen, 5, RUNTIME_USER_ID);
  await screen.press("down");
  await screen.press("return");
  await screen.write(APPLICATION_HEADER);
  await screen.write("\x04");
  await editText(screen, 1, token);
  await screen.press("escape");
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
    expect(
      core.runtime.calls.some(
        (call) => call.method === "listRuntimeEndpoints" && call.args[0] === runtimeId,
      ),
    ).toBe(true);
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

  test("idle esc from an initial console returns to its endpoint picker", async () => {
    const core = new TestCoreClient();
    core.runtime
      .setGetResponse({ agentRuntimeArn: RUNTIME_ARN } as GetAgentRuntimeResponse)
      .setListEndpointsResponse({
        runtimeEndpoints: [endpoint({ name: "back-to-endpoint-picker", id: "back-endpoint" })],
      });
    const screen = renderScreen(CONSOLE_PATH, { core });

    await waitForText(screen.lastFrame, "idle");
    await screen.press("escape");

    await waitForText(screen.lastFrame, "back-to-endpoint-picker");
    expect(screen.lastFrame()).toContain(`agentcore → runtime → invoke → ${RUNTIME_ID}`);
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

describe("Runtime invoke console", () => {
  test("edits an inline payload at the cursor before sending", async () => {
    const core = new TestCoreClient();
    core.runtime
      .setGetResponse({ agentRuntimeArn: RUNTIME_ARN } as GetAgentRuntimeResponse)
      .setInvokeResponse({
        statusCode: 200,
        contentType: "text/plain",
        body: responseBody(Buffer.from("ok")),
      });
    const screen = renderScreen(CONSOLE_PATH, { core });

    await waitForText(screen.lastFrame, "idle");
    await screen.write("abc");
    await screen.press("left");
    await screen.write("X");

    await waitForText(screen.lastFrame, "abXc");
    expect(screen.lastFrame()).not.toContain("abcX");
    await screen.write("\x7f");
    await waitFor(() => !(screen.lastFrame() ?? "").includes("abXc"));
    await screen.write("Y");
    await waitForText(screen.lastFrame, "abYc");

    await screen.press("return");
    await waitFor(
      () => core.runtime.calls.filter((call) => call.method === "invokeRuntime").length === 1,
    );
    const request = core.runtime.calls.find((call) => call.method === "invokeRuntime")!
      .args[0] as RuntimeInvokeRequest;
    expect(new TextDecoder().decode(request.payload)).toBe("abYc");
    const frame = screen.lastFrame()!;
    expect(frame).toContain("[↑↓] scroll");
    expect(frame).toContain("[ctl+c] quit");
    expect(frame).toContain("Payload · application/json");
    expect(frame).not.toContain("❯");
  });

  test.each([
    ["Shift+Enter", "\x1b[13;2u"],
    ["Alt+Enter", "\x1b\r"],
  ])("%s inserts a newline without sending", async (_shortcut, input) => {
    const core = new TestCoreClient();
    core.runtime
      .setGetResponse({ agentRuntimeArn: RUNTIME_ARN } as GetAgentRuntimeResponse)
      .setInvokeResponse({
        statusCode: 200,
        contentType: "text/plain",
        body: responseBody(Buffer.from("ok")),
      });
    const screen = renderScreen(CONSOLE_PATH, { core });

    await waitForText(screen.lastFrame, "idle");
    await screen.write("first");
    await screen.write(input);
    await screen.write("second");
    await waitForText(screen.lastFrame, "first\nsecond");
    expect(core.runtime.calls.filter((call) => call.method === "invokeRuntime")).toHaveLength(0);

    await screen.press("return");
    await waitFor(
      () => core.runtime.calls.filter((call) => call.method === "invokeRuntime").length === 1,
    );
    const request = core.runtime.calls.find((call) => call.method === "invokeRuntime")!
      .args[0] as RuntimeInvokeRequest;
    expect(new TextDecoder().decode(request.payload)).toBe("first\nsecond");
  });

  test("labels the payload editor with its active content type", async () => {
    const core = new TestCoreClient();
    core.runtime.setGetResponse({ agentRuntimeArn: RUNTIME_ARN } as GetAgentRuntimeResponse);
    const screen = renderScreen(CONSOLE_PATH, { core });

    await waitForText(screen.lastFrame, "Payload · application/json");
    expect(screen.lastFrame()).toContain("Enter JSON payload");

    await screen.write("\x0f");
    await waitForText(screen.lastFrame, "Request options");
    await screen.press("down");
    await screen.press("return");
    await screen.press("down");
    await screen.press("return");
    await screen.press("escape");

    await waitForText(screen.lastFrame, "Payload · text/plain");
    expect(screen.lastFrame()).toContain("Enter text payload");
  });

  test("accepts the next payload draft while a response is streaming", async () => {
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

    await waitForText(screen.lastFrame, "idle");
    await screen.write("first");
    await screen.press("return");
    await waitForText(screen.lastFrame, "partial");
    await screen.write("second");
    await waitForText(screen.lastFrame, "second");
    await screen.press("return");
    expect(requests).toHaveLength(1);

    release.resolve();
    await waitForText(screen.lastFrame, "idle");
    await screen.press("return");
    await waitFor(() => requests.length === 2);

    expect(new TextDecoder().decode(requests[1]!.payload)).toBe("second");
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

    await waitForText(screen.lastFrame, "idle");
    await screen.write("{}");
    const frameCount = screen.frames.length;
    await screen.press("return");
    await waitForText(screen.lastFrame, "partial");

    const streamingFrames = screen.frames
      .slice(frameCount)
      .filter((frame) => frame.includes("streaming…"));
    expect(streamingFrames.length).toBeGreaterThan(0);
    for (const frame of streamingFrames) {
      expect(frame).not.toContain("Runtime returned-runtime");
      expect(frame).not.toContain("streaming ·");
    }

    release.resolve();
    await waitForText(screen.lastFrame, "complete · 16 bytes");
    expect(screen.lastFrame()).toContain("Runtime returned-runtime");
  });

  test("manual scrolling stays detached while a response continues streaming", async () => {
    const release = Promise.withResolvers<void>();
    let deliveredTail = false;
    const initial = Array.from({ length: 50 }, (_, index) => `line-${index}`).join("\n");
    const core = new TestCoreClient();
    core.runtime
      .setGetResponse({ agentRuntimeArn: RUNTIME_ARN } as GetAgentRuntimeResponse)
      .setInvokeResponse({
        statusCode: 200,
        contentType: "text/plain",
        body: (async function* () {
          yield Buffer.from(initial);
          await release.promise;
          deliveredTail = true;
          yield Buffer.from("\nline-50");
        })(),
      });
    const screen = renderScreen(CONSOLE_PATH, { core });

    await waitForText(screen.lastFrame, "idle");
    await screen.write("{}");
    await screen.write("\x04");
    await waitForText(screen.lastFrame, "line-49");
    for (let index = 0; index < 10; index++) await screen.press("up");
    await waitForText(screen.lastFrame, "line-20");
    const frameCount = screen.frames.length;

    release.resolve();
    await waitFor(() => deliveredTail && screen.frames.length > frameCount);

    expect(screen.lastFrame()).toContain("line-20");
    expect(screen.lastFrame()).not.toContain("line-50");
  });

  test.each([
    ["HTTP/IAM", {}, false],
    [
      "MCP/CUSTOM_JWT",
      {
        protocolConfiguration: { serverProtocol: "MCP" },
        authorizerConfiguration: { customJWTAuthorizer: {} },
      },
      true,
    ],
  ])("Ctrl+O shows one-column options for %s", async (_name, overrides, conditional) => {
    const core = new TestCoreClient();
    core.runtime.setGetResponse({
      agentRuntimeArn: RUNTIME_ARN,
      protocolConfiguration: { serverProtocol: "HTTP" },
      ...overrides,
    } as GetAgentRuntimeResponse);
    const screen = renderScreen(CONSOLE_PATH, { core });

    await waitForText(screen.lastFrame, "idle");
    await screen.write("\x0f");
    await waitForText(screen.lastFrame, "Request options");
    const frame = screen.lastFrame()!;
    expect(frame.includes("Bearer JWT")).toBe(conditional);
    expect(frame.includes("│ MCP")).toBe(conditional);
    expect(
      frame
        .split("\n")
        .every((line) => !(line.includes("Content type") && line.includes("Runtime user ID"))),
    ).toBe(true);
    if (!conditional) {
      await screen.press("down");
      await screen.press("return");
      await waitForText(screen.lastFrame, "application/octet-stream");
      expect(screen.lastFrame()).toContain("text/plain");
    }
  });

  test("floats options over the console without editing the background payload", async () => {
    const core = new TestCoreClient();
    core.runtime.setGetResponse({ agentRuntimeArn: RUNTIME_ARN } as GetAgentRuntimeResponse);
    const screen = renderScreen(CONSOLE_PATH, { core });

    await waitForText(screen.lastFrame, "idle");
    await screen.write("draft payload");
    await screen.write("\x0f");
    await waitForText(screen.lastFrame, "Request options");

    const optionsFrame = screen.lastFrame()!;
    expect(optionsFrame).toContain("Payload · application/json");
    expect(optionsFrame).toContain("draft payload");
    expect(optionsFrame).toContain("idle · Sessions");
    expect(optionsFrame).toContain("╭");
    const panelLines = optionsFrame.split("\n");
    const panelTop = panelLines.findIndex((line) => line.includes("╭"));
    const panelBottom = panelLines.findIndex((line) => line.includes("╰"));
    expect(panelBottom - panelTop + 1).toBeGreaterThanOrEqual(26);

    await screen.write("ignored");
    await screen.press("escape");
    await waitForText(screen.lastFrame, "idle");
    expect(screen.lastFrame()).toContain("draft payload");
    expect(screen.lastFrame()).not.toContain("ignored");
  });

  test("uses the full-screen options fallback in a compact terminal", async () => {
    const core = new TestCoreClient();
    core.runtime.setGetResponse({ agentRuntimeArn: RUNTIME_ARN } as GetAgentRuntimeResponse);
    const screen = renderScreen(CONSOLE_PATH, { core });

    await waitForText(screen.lastFrame, "idle");
    await screen.resize(60, 24);
    await screen.write("\x0f");
    await waitForText(screen.lastFrame, "Request options");

    expect(screen.lastFrame()).not.toContain("Payload · application/json");
    expect(screen.lastFrame()).not.toContain("idle · Sessions");
  });

  test("manually edited protocol options reach invoke", async () => {
    const core = new TestCoreClient();
    core.runtime
      .setGetResponse({
        agentRuntimeArn: RUNTIME_ARN,
        protocolConfiguration: { serverProtocol: "MCP" },
        authorizerConfiguration: { customJWTAuthorizer: {} },
        requestHeaderConfiguration: { requestHeaderAllowlist: ["X-Tenant"] },
      } as GetAgentRuntimeResponse)
      .setInvokeResponse({
        statusCode: 200,
        contentType: "text/plain",
        body: splitUtf8("ok", 1),
      });
    const screen = renderScreen(CONSOLE_PATH, { core });

    await waitForText(screen.lastFrame, "idle");
    await screen.write("\x0f");
    await waitForText(screen.lastFrame, "Request options");
    await editCustom(screen, 1, 3, "application/vnd.test+json");
    await editCustom(screen, 1, 5, "application/vnd.test-response+json");
    await editText(screen, 2, "runtime-session");
    await editText(screen, 1, "runtime-user");
    await screen.press("down");
    await screen.press("return");
    await screen.write("X-Tenant: retail\nX-Amzn-Bedrock-AgentCore-Runtime-Custom-Mode: fast");
    await screen.write("\x04");
    await editText(screen, 1, "bearer-token");
    await editText(screen, 1, "mcp-session");
    await editText(screen, 1, "2025-06-18");
    await editCustom(screen, 1, 4, "tasks/run");
    await editText(screen, 1, "task-name");
    await editText(screen, 1, "trace-id");
    await editText(screen, 1, "00-trace-id-span-id-01");
    await editText(screen, 1, "vendor=value");
    await editText(screen, 1, "tenant=retail");
    await screen.press("escape");
    await waitForText(screen.lastFrame, "idle");

    await screen.write("{}");
    await screen.write("\x04");
    await waitFor(
      () => core.runtime.calls.filter((c) => c.method === "invokeRuntime").length === 1,
    );

    const request = core.runtime.calls.find((call) => call.method === "invokeRuntime")!
      .args[0] as RuntimeInvokeRequest;
    expect(request).toMatchObject({
      contentType: "application/vnd.test+json",
      accept: "application/vnd.test-response+json",
      runtimeSessionId: "runtime-session",
      runtimeUserId: "runtime-user",
      applicationHeaders: [
        ["X-Tenant", "retail"],
        ["X-Amzn-Bedrock-AgentCore-Runtime-Custom-Mode", "fast"],
      ],
      bearerToken: "bearer-token",
      mcpSessionId: "mcp-session",
      mcpProtocolVersion: "2025-06-18",
      mcpMethod: "tasks/run",
      mcpName: "task-name",
      traceId: "trace-id",
      traceParent: "00-trace-id-span-id-01",
      traceState: "vendor=value",
      baggage: "tenant=retail",
    });
  });

  test("Request options editors save drafts and Esc cancels them", async () => {
    const core = new TestCoreClient();
    core.runtime.setGetResponse({ agentRuntimeArn: RUNTIME_ARN } as GetAgentRuntimeResponse);
    const screen = renderScreen(CONSOLE_PATH, { core });

    await waitForText(screen.lastFrame, "idle");
    await screen.write("\x0f");
    await waitForText(screen.lastFrame, "Request options");
    await moveDown(screen, 1);
    await screen.press("return");
    await moveDown(screen, 3);
    await screen.press("return");
    await screen.write("application/cancelled");
    await screen.press("escape");
    await waitForText(screen.lastFrame, "Request options");
    expect(screen.lastFrame()).toMatch(/Content type\s+application\/json/);
    expect(screen.lastFrame()).not.toContain("application/cancelled");

    await screen.press("return");
    await moveDown(screen, 3);
    await screen.press("return");
    await screen.write("application/saved");
    await screen.press("return");
    await waitForText(screen.lastFrame, "application/saved");

    await moveDown(screen, 5);
    await screen.press("return");
    await screen.write("X-Test: cancelled");
    await screen.press("escape");
    await waitForText(screen.lastFrame, "Request options");
    expect(screen.lastFrame()).not.toContain("X-Test: cancelled");

    await screen.press("return");
    await screen.write("X-Test: saved");
    await screen.write("\x04");
    await waitForText(screen.lastFrame, "1 header");
  });

  test("Ctrl+T preserves Runtime-scoped credentials across endpoints and clears sessions", async () => {
    const nextQualifier = "canary";
    const token = "token-secret";
    const core = new TestCoreClient();
    core.runtime
      .setGetResponse({
        agentRuntimeArn: RUNTIME_ARN,
        authorizerConfiguration: { customJWTAuthorizer: {} },
        requestHeaderConfiguration: { requestHeaderAllowlist: ["X-Tenant"] },
      } as GetAgentRuntimeResponse)
      .setListResponse({
        agentRuntimes: [runtime()],
      })
      .setListEndpointsResponse({
        runtimeEndpoints: [endpoint({ name: nextQualifier, id: nextQualifier })],
      })
      .setInvokeResponse({
        statusCode: 200,
        contentType: "text/plain",
        runtimeSessionId: "returned-runtime",
        mcpSessionId: "returned-mcp",
        body: responseBody(Buffer.from("old response")),
      });
    const screen = renderScreen(CONSOLE_PATH, { core });

    await waitForText(screen.lastFrame, "idle");
    await configureRuntimeScopedOptions(screen, token);
    await screen.write("first");
    await screen.write("\x04");
    await waitForText(screen.lastFrame, "old response");
    await waitForText(screen.lastFrame, "idle");

    await screen.write("\x14");
    await waitForText(screen.lastFrame, "choose another Runtime");
    await screen.press("escape");
    await waitForText(screen.lastFrame, "old response");

    await screen.write("\x14");
    await waitForText(screen.lastFrame, "choose another Runtime");
    await screen.press("return");
    await waitForText(screen.lastFrame, nextQualifier);
    await screen.press("return");
    await waitForText(
      screen.lastFrame,
      `agentcore → runtime → invoke → ${RUNTIME_ID} → ${nextQualifier}`,
    );
    await waitForText(screen.lastFrame, "idle");
    expect(screen.lastFrame()).not.toContain("old response");
    expect(screen.lastFrame()).toContain("Sessions: Runtime new · MCP new");

    await screen.write("\x0f");
    await waitForText(screen.lastFrame, "Request options");
    const endpointOptions = screen.lastFrame()!;
    expect(endpointOptions).toMatch(new RegExp(`User ID\\s+${RUNTIME_USER_ID}`));
    expect(endpointOptions).toMatch(/Application headers\s+1 header/);
    expect(endpointOptions).toMatch(/Bearer JWT\s+Configured/);
    expect(endpointOptions).not.toContain(APPLICATION_HEADER);
    expect(endpointOptions).not.toContain(token);
    await screen.press("escape");

    core.runtime.setInvokeResponse({
      statusCode: 200,
      contentType: "text/plain",
      body: responseBody(Buffer.from("new response")),
    });
    await screen.write("second");
    await screen.write("\x04");
    await waitFor(
      () => core.runtime.calls.filter((call) => call.method === "invokeRuntime").length === 2,
    );

    const second = core.runtime.calls.filter((call) => call.method === "invokeRuntime")[1]!
      .args[0] as RuntimeInvokeRequest;
    expect(second).toMatchObject({
      runtimeId: RUNTIME_ID,
      qualifier: nextQualifier,
      runtimeUserId: RUNTIME_USER_ID,
      bearerToken: token,
      applicationHeaders: [["X-Tenant", "secret-header"]],
    });
    expect(second.runtimeSessionId).toBeUndefined();
    expect(second.mcpSessionId).toBeUndefined();
  });

  test("Ctrl+T clears Runtime-scoped credentials and sessions for another Runtime", async () => {
    const nextRuntimeId = "runtime-next";
    const nextQualifier = "canary";
    const nextArn = RUNTIME_ARN.replace(RUNTIME_ID, nextRuntimeId);
    const token = "token-secret";
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
        runtimeSessionId: "returned-runtime",
        mcpSessionId: "returned-mcp",
        body: responseBody(Buffer.from("old response")),
      });
    const screen = renderScreen(CONSOLE_PATH, { core });

    await waitForText(screen.lastFrame, "idle");
    await configureRuntimeScopedOptions(screen, token);
    await screen.write("first");
    await screen.write("\x04");
    await waitForText(screen.lastFrame, "old response");
    await waitForText(screen.lastFrame, "idle");

    core.runtime.setGetResponse({
      agentRuntimeArn: nextArn,
      protocolConfiguration: { serverProtocol: "HTTP" },
    } as GetAgentRuntimeResponse);
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
    await waitForText(screen.lastFrame, "idle");
    expect(screen.lastFrame()).not.toContain("old response");
    expect(screen.lastFrame()).toContain("Sessions: Runtime new · MCP new");

    await screen.write("\x0f");
    await waitForText(screen.lastFrame, "Request options");
    const options = screen.lastFrame()!;
    expect(options).toMatch(new RegExp(`User ID\\s+${RUNTIME_USER_ID}`));
    expect(options).not.toContain("secret-header");
    expect(options).not.toContain("*".repeat(token.length));
    await screen.press("escape");

    core.runtime.setInvokeResponse({
      statusCode: 200,
      contentType: "text/plain",
      body: responseBody(Buffer.from("new response")),
    });
    await screen.write("second");
    await screen.write("\x04");
    await waitFor(
      () => core.runtime.calls.filter((call) => call.method === "invokeRuntime").length === 2,
    );

    const second = core.runtime.calls.filter((call) => call.method === "invokeRuntime")[1]!
      .args[0] as RuntimeInvokeRequest;
    expect(second).toMatchObject({
      runtimeId: nextRuntimeId,
      qualifier: nextQualifier,
      runtimeUserId: RUNTIME_USER_ID,
    });
    expect(second.bearerToken).toBeUndefined();
    expect(second.applicationHeaders).toBeUndefined();
    expect(second.runtimeSessionId).toBeUndefined();
    expect(second.mcpSessionId).toBeUndefined();
  });

  test("switching from MCP to HTTP omits hidden MCP options", async () => {
    const nextRuntimeId = "runtime-http";
    const nextQualifier = "http";
    const nextArn = RUNTIME_ARN.replace(RUNTIME_ID, nextRuntimeId);
    const core = new TestCoreClient();
    core.runtime
      .setGetResponse({
        agentRuntimeArn: RUNTIME_ARN,
        protocolConfiguration: { serverProtocol: "MCP" },
      } as GetAgentRuntimeResponse)
      .setListResponse({
        agentRuntimes: [
          runtime({
            agentRuntimeId: nextRuntimeId,
            agentRuntimeName: "http-runtime",
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
        body: responseBody(Buffer.from("http response")),
      });
    const screen = renderScreen(CONSOLE_PATH, { core });

    await waitForText(screen.lastFrame, "idle");
    await screen.write("\x0f");
    await waitForText(screen.lastFrame, "Request options");
    await editText(screen, 7, "mcp-session");
    await editText(screen, 1, "2025-06-18");
    await editCustom(screen, 1, 4, "tasks/run");
    await editText(screen, 1, "task-name");
    await screen.press("escape");

    core.runtime.setGetResponse({
      agentRuntimeArn: nextArn,
      protocolConfiguration: { serverProtocol: "HTTP" },
    } as GetAgentRuntimeResponse);
    await screen.write("\x14");
    await waitForText(screen.lastFrame, "http-runtime");
    await screen.press("return");
    await waitForText(screen.lastFrame, nextQualifier);
    await screen.press("return");
    await waitForText(
      screen.lastFrame,
      `agentcore → runtime → invoke → ${nextRuntimeId} → ${nextQualifier}`,
    );
    await waitForText(screen.lastFrame, "idle");

    await screen.write("{}");
    await screen.write("\x04");

    await waitForText(screen.lastFrame, "http response");
    const request = core.runtime.calls.find((call) => call.method === "invokeRuntime")!
      .args[0] as RuntimeInvokeRequest;
    expect(request).not.toHaveProperty("mcpSessionId");
    expect(request).not.toHaveProperty("mcpProtocolVersion");
    expect(request).not.toHaveProperty("mcpMethod");
    expect(request).not.toHaveProperty("mcpName");
  });

  test("preserves raw SSE text and both requests across two sends", async () => {
    const firstResponse = 'data: {"first":"€"}\n\nnot-json';
    const secondResponse = '{"second":true}\nraw: ✓';
    const firstGate = Promise.withResolvers<void>();
    const firstBytes = new TextEncoder().encode(firstResponse);
    const firstBody = (async function* () {
      yield firstBytes.slice(0, 18);
      await firstGate.promise;
      yield firstBytes.slice(18);
    })();
    const core = new TestCoreClient();
    core.runtime
      .setGetResponse({
        agentRuntimeArn: RUNTIME_ARN,
        protocolConfiguration: { serverProtocol: "MCP" },
      } as GetAgentRuntimeResponse)
      .setInvokeResponse({
        statusCode: 202,
        contentType: "text/event-stream",
        runtimeSessionId: "returned-runtime",
        mcpSessionId: "returned-mcp",
        traceId: "trace-id",
        traceParent: "trace-parent",
        traceState: "trace-state",
        baggage: "tenant=retail",
        body: firstBody,
      })
      .queueInvokeBody(firstBody)
      .queueInvokeBody(splitUtf8(secondResponse, 23));
    const screen = renderScreen(CONSOLE_PATH, { core });

    await waitForText(screen.lastFrame, "Enter JSON payload");
    await screen.write("first");
    await screen.write("\x1b[13;2u");
    await screen.write("payload");
    await screen.write("\x04");
    await waitForText(screen.lastFrame, 'data: {"first":"');

    await screen.write("\x04");
    expect(core.runtime.calls.filter((call) => call.method === "invokeRuntime")).toHaveLength(1);

    firstGate.resolve();
    await waitForText(screen.lastFrame, firstResponse);
    await waitForText(screen.lastFrame, "idle");

    await screen.write("second payload");
    await screen.write("\x04");
    await waitForText(screen.lastFrame, secondResponse);
    await waitFor(
      () => core.runtime.calls.filter((call) => call.method === "invokeRuntime").length === 2,
    );

    const requests = core.runtime.calls
      .filter((call) => call.method === "invokeRuntime")
      .map((call) => call.args[0] as RuntimeInvokeRequest);
    expect(
      requests.map(({ runtimeId, qualifier, payload }) => ({
        runtimeId,
        qualifier,
        payload: new TextDecoder().decode(payload),
      })),
    ).toEqual([
      {
        runtimeId: RUNTIME_ID,
        qualifier: QUALIFIER,
        payload: "first\npayload",
      },
      {
        runtimeId: RUNTIME_ID,
        qualifier: QUALIFIER,
        payload: "second payload",
      },
    ]);
    expect(core.runtime.calls.filter((call) => call.method === "getRuntime")).toHaveLength(1);

    const finalFrame = screen.lastFrame()!;
    expect(finalFrame).toContain("first\npayload");
    expect(finalFrame).toContain(firstResponse);
    expect(finalFrame).toContain(
      `Request\nsecond payload\nResponse · 202 · text/event-stream\n${secondResponse}`,
    );
    expect(
      finalFrame.match(new RegExp(secondResponse.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")),
    ).toHaveLength(1);
    expect(finalFrame.match(/first\npayload/g)).toHaveLength(1);
    expect(finalFrame.match(/data: \{"first":"€"\}/g)).toHaveLength(1);
    expect(finalFrame).toContain(`agentcore → runtime → invoke → ${RUNTIME_ID} → ${QUALIFIER}`);
    expect(finalFrame).toContain("Sessions: Runtime returned-runtime · MCP returned-mcp");
    expect(finalFrame).toContain("Response · 202 · text/event-stream");
    expect(finalFrame).toContain(
      "Runtime returned-runtime · MCP returned-mcp · trace trace-id · traceparent trace-parent",
    );
    expect(finalFrame).toContain(
      `complete · ${new TextEncoder().encode(secondResponse).byteLength} bytes`,
    );
  });

  test("toggles a completed valid JSON response between raw and pretty text with Ctrl+V", async () => {
    const raw = '{"z":1,"nested":{"ok":true}}';
    const first = '{"z":1,';
    const second = '"nested":{"ok":true}}';
    const pretty = JSON.stringify(JSON.parse(raw), null, 2);
    const release = Promise.withResolvers<void>();
    const mutable = Buffer.alloc(second.length);
    const core = new TestCoreClient();
    core.runtime
      .setGetResponse({ agentRuntimeArn: RUNTIME_ARN } as GetAgentRuntimeResponse)
      .setInvokeResponse({
        statusCode: 200,
        contentType: "application/json",
        body: (async function* () {
          mutable.set(Buffer.from(first));
          yield mutable.subarray(0, first.length);
          await release.promise;
          mutable.set(Buffer.from(second));
          yield mutable.subarray(0, second.length);
        })(),
      });
    const screen = renderScreen(CONSOLE_PATH, { core });

    await waitForText(screen.lastFrame, "idle");
    await screen.write("\x04");
    await waitForText(screen.lastFrame, first);
    expect(screen.lastFrame()).toContain("streaming…");

    release.resolve();
    await waitForText(screen.lastFrame, raw);
    await waitForText(screen.lastFrame, "idle");

    await screen.write("\x16");
    await waitForText(screen.lastFrame, pretty);
    await screen.write("\x16");
    await waitForText(screen.lastFrame, raw);
  });

  test("keeps invalid completed JSON raw, notes the presentation error, and returns idle", async () => {
    const raw = '{"broken":';
    const core = new TestCoreClient();
    core.runtime
      .setGetResponse({ agentRuntimeArn: RUNTIME_ARN } as GetAgentRuntimeResponse)
      .setInvokeResponse({
        statusCode: 200,
        contentType: "application/json",
        body: responseBody(Buffer.from(raw)),
      });
    const screen = renderScreen(CONSOLE_PATH, { core });

    await waitForText(screen.lastFrame, "idle");
    await screen.write("\x04");

    await waitForText(screen.lastFrame, raw);
    await waitForText(screen.lastFrame, "Invalid JSON response; showing raw text.");
    await waitForText(screen.lastFrame, "idle");
  });

  test("keeps invalid UTF-8 bytes and shows a presentation error after completion", async () => {
    const core = new TestCoreClient();
    core.runtime
      .setGetResponse({ agentRuntimeArn: RUNTIME_ARN } as GetAgentRuntimeResponse)
      .setInvokeResponse({
        statusCode: 200,
        contentType: "text/plain",
        body: responseBody(Buffer.from([0x66, 0x80])),
      });
    const screen = renderScreen(CONSOLE_PATH, { core });

    await waitForText(screen.lastFrame, "idle");
    await screen.write("\x04");

    await waitForText(screen.lastFrame, "f�");
    await waitForText(screen.lastFrame, "Invalid UTF-8 response; showing raw text.");
    await waitForText(screen.lastFrame, "idle");
  });

  test("does not consume a binary Console response", async () => {
    let iterations = 0;
    const source = (async function* () {
      iterations++;
      yield Buffer.from([0, 255]);
    })();
    const core = new TestCoreClient();
    core.runtime
      .setGetResponse({ agentRuntimeArn: RUNTIME_ARN } as GetAgentRuntimeResponse)
      .setInvokeResponse({
        statusCode: 200,
        contentType: "application/octet-stream",
        runtimeSessionId: "refused-runtime",
        mcpSessionId: "refused-mcp",
        body: source,
      });
    const screen = renderScreen(CONSOLE_PATH, { core });

    await waitForText(screen.lastFrame, "idle");
    await screen.write("\x04");

    await waitForText(
      screen.lastFrame,
      "Binary or unknown response content requires File destination.",
    );
    await waitForText(screen.lastFrame, "idle");
    expect(iterations).toBe(0);
    const signal = core.runtime.calls.find((call) => call.method === "invokeRuntime")!
      .args[2] as AbortSignal;
    expect(signal.aborted).toBe(true);
    expect(screen.lastFrame()).toContain("Sessions: Runtime new · MCP new");
  });

  test("writes a binary File response exactly and records its byte count", async () => {
    const file = join(tmpdir(), `runtime-binary-response-${process.pid}`);
    const bytes = Buffer.from([0, 255, 10, 1]);
    const core = new TestCoreClient();
    core.runtime
      .setGetResponse({ agentRuntimeArn: RUNTIME_ARN } as GetAgentRuntimeResponse)
      .setInvokeResponse({
        statusCode: 200,
        contentType: "application/octet-stream",
        body: responseBody(bytes.slice(0, 2), bytes.slice(2)),
      });
    const screen = renderScreen(CONSOLE_PATH, { core });

    try {
      await waitForText(screen.lastFrame, "idle");
      await screen.write("\x0f");
      await waitForText(screen.lastFrame, "Request options");
      for (let index = 0; index < 3; index++) await screen.press("down");
      await screen.press("return");
      await screen.press("down");
      await screen.press("return");
      await screen.press("down");
      await screen.press("return");
      await screen.write(file);
      await screen.press("return");
      await screen.press("escape");
      await waitForText(screen.lastFrame, "idle");

      await screen.write("\x04");

      await waitForText(screen.lastFrame, `Saved 4 bytes to ${file}`);
      expect(Buffer.from(await Bun.file(file).bytes())).toEqual(bytes);
    } finally {
      await rm(file, { force: true });
    }
  });

  test("requires a File response path before invoking", async () => {
    const core = new TestCoreClient();
    core.runtime.setGetResponse({ agentRuntimeArn: RUNTIME_ARN } as GetAgentRuntimeResponse);
    const screen = renderScreen(CONSOLE_PATH, { core });

    await waitForText(screen.lastFrame, "idle");
    await screen.write("\x0f");
    await waitForText(screen.lastFrame, "Request options");
    for (let index = 0; index < 3; index++) await screen.press("down");
    await screen.press("return");
    await screen.press("down");
    await screen.press("return");
    await screen.press("escape");
    await screen.write("\x04");

    await waitForText(screen.lastFrame, "Response path is required for File destination.");
    expect(core.runtime.calls.filter((call) => call.method === "invokeRuntime")).toHaveLength(0);
  });

  test("shows unreadable payload files as local request errors", async () => {
    const missing = join(tmpdir(), `missing-runtime-screen-payload-${process.pid}`);
    const core = new TestCoreClient();
    core.runtime.setGetResponse({ agentRuntimeArn: RUNTIME_ARN } as GetAgentRuntimeResponse);
    const screen = renderScreen(CONSOLE_PATH, { core });

    await waitForText(screen.lastFrame, "idle");
    await screen.write("\x0f");
    await waitForText(screen.lastFrame, "Request options");
    await screen.press("return");
    await screen.press("down");
    await screen.press("return");
    await editText(screen, 1, missing);
    await screen.press("escape");
    await screen.write("\x04");

    await waitForText(screen.lastFrame, "Error: could not read '--payload' from file");
    await waitForText(screen.lastFrame, "idle");
    expect(screen.lastFrame()).not.toContain("response stream failed");
    expect(core.runtime.calls.filter((call) => call.method === "invokeRuntime")).toHaveLength(0);
  });

  test("rejects stdin payload sources without consuming TUI input", async () => {
    const core = new TestCoreClient();
    core.runtime.setGetResponse({ agentRuntimeArn: RUNTIME_ARN } as GetAgentRuntimeResponse);
    const screen = renderScreen(CONSOLE_PATH, { core });

    await waitForText(screen.lastFrame, "idle");
    await screen.write("-");
    await screen.write("\x04");

    await waitForText(
      screen.lastFrame,
      "Error: stdin sources are not available in the interactive console",
    );
    await waitForText(screen.lastFrame, "idle");
    expect(core.runtime.calls.filter((call) => call.method === "invokeRuntime")).toHaveLength(0);
  });

  test("shows a CUSTOM_JWT HTTP status without exposing request or response secrets", async () => {
    const token = "secret-bearer-token";
    const responseBody = "secret response body";
    const core = new TestCoreClient();
    core.runtime.setGetResponse({
      agentRuntimeArn: RUNTIME_ARN,
      authorizerConfiguration: { customJWTAuthorizer: {} },
    } as GetAgentRuntimeResponse);
    core.runtime.invokeRuntime = async () => {
      throw Object.assign(new Error("HTTP 401"), {
        cause: new Error(`Bearer ${token}: ${responseBody}`),
      });
    };
    const screen = renderScreen(CONSOLE_PATH, { core });

    await waitForText(screen.lastFrame, "idle");
    await screen.write("\x0f");
    await waitForText(screen.lastFrame, "Request options");
    await editText(screen, 7, token);
    await screen.press("escape");
    await screen.write("{}");
    await screen.write("\x04");

    await waitForText(screen.lastFrame, "HTTP 401");
    const frame = screen.lastFrame()!;
    expect(frame).not.toContain("response stream failed");
    expect(frame).not.toContain(token);
    expect(frame).not.toContain(responseBody);
  });

  test("shows sanitized Core invocation diagnostics", async () => {
    const message =
      "Runtime invocation failed (ValidationException, HTTP 400, request ID request-123)";
    const core = new TestCoreClient();
    core.runtime.setGetResponse({ agentRuntimeArn: RUNTIME_ARN } as GetAgentRuntimeResponse);
    core.runtime.invokeRuntime = async () => {
      throw new Error(message);
    };
    const screen = renderScreen(CONSOLE_PATH, { core });

    await waitForText(screen.lastFrame, "idle");
    await screen.write("{}");
    await screen.write("\x04");

    await waitForText(screen.lastFrame, message);
    expect(screen.lastFrame()).not.toContain("response stream failed");
  });

  test("adopts returned sessions only after response completion", async () => {
    const requests: RuntimeInvokeRequest[] = [];
    const core = new TestCoreClient();
    core.runtime.setGetResponse({ agentRuntimeArn: RUNTIME_ARN } as GetAgentRuntimeResponse);
    core.runtime.invokeRuntime = async (request) => {
      requests.push(request);
      if (requests.length === 1) {
        return {
          statusCode: 200,
          contentType: "text/plain",
          runtimeSessionId: "failed-runtime",
          mcpSessionId: "failed-mcp",
          body: (async function* () {
            yield Buffer.from("partial");
            throw new Error("stream failed");
          })(),
        };
      }
      return {
        statusCode: 200,
        contentType: "text/plain",
        body: responseBody(Buffer.from("ok")),
      };
    };
    const screen = renderScreen(CONSOLE_PATH, { core });

    await waitForText(screen.lastFrame, "idle");
    await screen.write("first");
    await screen.write("\x04");
    await waitForText(screen.lastFrame, "response stream failed");
    await waitForText(screen.lastFrame, "idle");
    await screen.write("second");
    await screen.write("\x04");
    await waitFor(() => requests.length === 2);

    expect(requests[1]!.runtimeSessionId).toBeUndefined();
    expect(requests[1]!.mcpSessionId).toBeUndefined();
  });

  test("Esc interrupts while connecting and returns the console to idle", async () => {
    const core = new TestCoreClient();
    const connection = Promise.withResolvers<never>();
    let signal: AbortSignal | undefined;
    core.runtime.setGetResponse({ agentRuntimeArn: RUNTIME_ARN } as GetAgentRuntimeResponse);
    core.runtime.invokeRuntime = async (_request, _options, nextSignal) => {
      signal = nextSignal;
      nextSignal?.addEventListener(
        "abort",
        () =>
          connection.reject(
            Object.assign(new Error("The operation was aborted"), { name: "AbortError" }),
          ),
        { once: true },
      );
      return connection.promise;
    };
    const screen = renderScreen(CONSOLE_PATH, { core });

    try {
      await waitForText(screen.lastFrame, "idle");
      await screen.write("{}");
      await screen.write("\x04");
      await waitFor(() => signal !== undefined);
      expect(screen.lastFrame()).toContain("connecting…");

      await screen.press("escape");

      expect(signal!.aborted).toBe(true);
      await waitForText(screen.lastFrame, "interrupted");
      expect(screen.lastFrame()).toContain("idle");
    } finally {
      connection.reject(Object.assign(new Error("stop"), { name: "AbortError" }));
    }
  });

  test("Esc interrupts a response stream and keeps its partial text", async () => {
    const core = new TestCoreClient();
    const stop = Promise.withResolvers<void>();
    let signal: AbortSignal | undefined;
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
      await waitForText(screen.lastFrame, "idle");
      await screen.write("{}");
      await screen.write("\x04");
      await waitForText(screen.lastFrame, "data: partial");
      expect(screen.lastFrame()).toContain("streaming…");

      await screen.press("escape");

      expect(signal?.aborted).toBe(true);
      stop.reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
      await waitForText(screen.lastFrame, "interrupted · 14 bytes");
      expect(screen.lastFrame()).toContain("data: partial");
      expect(screen.lastFrame()).toContain("idle");
      expect(screen.lastFrame()).toContain("Sessions: Runtime new · MCP new");
    } finally {
      stop.reject(Object.assign(new Error("stop"), { name: "AbortError" }));
    }
  });
});
