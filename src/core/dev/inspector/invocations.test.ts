import { afterEach, describe, expect, test } from "bun:test";
import type { HttpRequestHandler } from "../../../io/httpServer";
import { ServerFarm, fakeSupervisor, post, runningAgent } from "./testkit";
import type { InspectorDeps } from "./types";

const farm = new ServerFarm();
afterEach(() => farm.close());

/** A fake agent that replies with a fixed SSE stream over its own body. */
function sseAgent(frames: string[]): HttpRequestHandler {
  return () => ({
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
    body: frames.map((frame) => `data: ${frame}\n\n`).join(""),
  });
}

/** Stand up a fake agent, point a running supervisor at it, and start the inspector. */
async function inspectorFor(handler: HttpRequestHandler, protocol = "HTTP") {
  const agent = await farm.serve(handler);
  const supervisor = fakeSupervisor({ agents: [runningAgent("orders", agent.port, protocol)] });
  return farm.inspector({ supervisor } satisfies InspectorDeps);
}

describe("POST /invocations routing", () => {
  test("returns 409 when no agent is running", async () => {
    const { url } = await farm.inspector({ supervisor: fakeSupervisor() });
    const response = await post(url, "/invocations", { prompt: "hi" });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ success: false });
  });

  test("directs MCP agents to the dedicated proxy instead of mis-proxying them", async () => {
    const { url } = await inspectorFor(sseAgent([]), "MCP");
    const response = await post(url, "/invocations", { agentName: "orders", prompt: "hi" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      success: false,
      error: "MCP agents are invoked through POST /api/mcp, not /invocations.",
    });
  });
});

describe("HTTP agent SSE normalization", () => {
  test.each([
    { name: "a bedrock text event", frame: JSON.stringify({ text: "hello" }), expected: "hello" },
    { name: "a bare JSON string token", frame: JSON.stringify("world"), expected: "world" },
    {
      name: "a ConverseStream content delta",
      frame: JSON.stringify({ event: { contentBlockDelta: { delta: { text: "delta" } } } }),
      expected: "delta",
    },
    { name: "a non-JSON plain-text token", frame: "raw-token", expected: "raw-token" },
  ])("normalizes $name to a data frame", async ({ frame, expected }) => {
    const { url } = await inspectorFor(sseAgent([frame]));
    const response = await post(url, "/invocations", { agentName: "orders", prompt: "hi" });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(await response.text()).toBe(`data: ${JSON.stringify(expected)}\n\n`);
  });

  test("re-frames an agent error event as an error payload", async () => {
    const { url } = await inspectorFor(sseAgent([JSON.stringify({ error: "boom" })]));
    const response = await post(url, "/invocations", { agentName: "orders", prompt: "hi" });
    expect(await response.text()).toBe(`data: ${JSON.stringify({ error: "boom" })}\n\n`);
  });

  test("passes a non-SSE response body through untouched", async () => {
    const { url } = await inspectorFor(() => ({
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answer: 42 }),
    }));
    const response = await post(url, "/invocations", { agentName: "orders", prompt: "hi" });
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ answer: 42 });
  });

  test("echoes one session id and forwards it to the agent", async () => {
    let received: string | undefined;
    const { url } = await inspectorFor((request) => {
      received = request.headers["x-amzn-bedrock-agentcore-runtime-session-id"] as string;
      return { status: 200, headers: { "Content-Type": "text/event-stream" }, body: "" };
    });
    const response = await post(url, "/invocations", {
      agentName: "orders",
      prompt: "hi",
      sessionId: "session-42",
    });
    expect(response.headers.get("x-session-id")).toBe("session-42");
    expect(received).toBe("session-42");
  });
});

describe("A2A agent invocation", () => {
  test("translates the prompt to message/stream and reduces events to text frames", async () => {
    let rpcMethod: string | undefined;
    const { url } = await inspectorFor((request) => {
      rpcMethod = (JSON.parse(request.body.toString()) as { method: string }).method;
      const status = JSON.stringify({
        result: {
          kind: "status-update",
          status: { message: { parts: [{ kind: "text", text: "streamed" }] } },
        },
      });
      return {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
        body: `data: ${status}\n\n`,
      };
    }, "A2A");
    const response = await post(url, "/invocations", { agentName: "orders", prompt: "hi" });
    expect(rpcMethod).toBe("message/stream");
    expect(await response.text()).toBe(`data: ${JSON.stringify("streamed")}\n\n`);
  });

  test("skips artifact text already streamed by a preceding status-update", async () => {
    const status = JSON.stringify({
      result: {
        kind: "status-update",
        status: { message: { parts: [{ kind: "text", text: "answer" }] } },
      },
    });
    const artifact = JSON.stringify({
      result: { kind: "artifact-update", artifact: { parts: [{ kind: "text", text: "answer" }] } },
    });
    const { url } = await inspectorFor(sseAgent([status, artifact]), "A2A");
    const response = await post(url, "/invocations", { agentName: "orders", prompt: "hi" });
    expect(await response.text()).toBe(`data: ${JSON.stringify("answer")}\n\n`);
  });

  test("falls back to extracting text from a non-streaming JSON-RPC result", async () => {
    const { url } = await inspectorFor(
      () => ({
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          result: { artifacts: [{ parts: [{ kind: "text", text: "final" }] }] },
        }),
      }),
      "A2A",
    );
    const response = await post(url, "/invocations", { agentName: "orders", prompt: "hi" });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(await response.text()).toBe(`data: ${JSON.stringify("final")}\n\n`);
  });

  test("requires a prompt", async () => {
    const { url } = await inspectorFor(sseAgent([]), "A2A");
    const response = await post(url, "/invocations", { agentName: "orders" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ success: false, error: "prompt is required" });
  });
});

describe("AGUI agent invocation", () => {
  test("sends a RunAgentInput body and passes the response through", async () => {
    let body: Record<string, unknown> | undefined;
    const { url } = await inspectorFor((request) => {
      body = JSON.parse(request.body.toString()) as Record<string, unknown>;
      return {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
        body: "data: passthrough\n\n",
      };
    }, "AGUI");
    const response = await post(url, "/invocations", { agentName: "orders", prompt: "hi" });
    expect(body).toMatchObject({ messages: [{ role: "user", content: "hi" }] });
    expect(await response.text()).toBe("data: passthrough\n\n");
  });
});
