import { afterEach, describe, expect, test } from "bun:test";
import { type HttpRequestHandler, startHttpServer } from "../../../io/httpServer";
import { parseAgentEvent } from "./invocations";
import { ServerFarm, fakeSupervisor, post, runningAgent } from "./testkit";
import type { InspectorDeps } from "./types";

const farm = new ServerFarm();
afterEach(() => farm.close());

function sseAgent(frames: string[]): HttpRequestHandler {
  return () => ({
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
    body: frames.map((frame) => `data: ${frame}\n\n`).join(""),
  });
}

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

describe("upstream connection failures", () => {
  async function deadPort(): Promise<number> {
    const handle = await startHttpServer(() => ({ status: 200 }));
    await handle.close();
    return handle.port;
  }

  test.each([
    { protocol: "HTTP", errorPrefix: "Agent server error" },
    { protocol: "A2A", errorPrefix: "A2A agent error" },
  ])("returns 502 when a $protocol agent is unreachable", async ({ protocol, errorPrefix }) => {
    const supervisor = fakeSupervisor({
      agents: [runningAgent("orders", await deadPort(), protocol)],
    });
    const { url } = await farm.inspector({ supervisor });
    const response = await post(url, "/invocations", { agentName: "orders", prompt: "hi" });
    expect(response.status).toBe(502);
    const body = (await response.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain(errorPrefix);
  });
});

describe("parseAgentEvent drops non-renderable frames", () => {
  test.each([
    { name: "a JSON primitive that is not text", data: JSON.stringify(42) },
    { name: "a blank error field", data: JSON.stringify({ error: "" }) },
    { name: "a blank text field", data: JSON.stringify({ text: "" }) },
    { name: "an empty non-JSON token", data: "" },
  ])("returns null for $name", ({ data }) => {
    expect(parseAgentEvent(data)).toBeNull();
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

  test.each([
    {
      name: "an artifact-update with no preceding status-update",
      frame: JSON.stringify({
        result: { kind: "artifact-update", artifact: { parts: [{ kind: "text", text: "art" }] } },
      }),
      expected: "art",
    },
    { name: "a frame that is not JSON", frame: "not-json", expected: "not-json" },
    {
      name: "a task event carrying a status message",
      frame: JSON.stringify({
        result: {
          kind: "task",
          status: { message: { parts: [{ kind: "text", text: "task-text" }] } },
        },
      }),
      expected: "task-text",
    },
  ])("streams text extracted from $name", async ({ frame, expected }) => {
    const { url } = await inspectorFor(sseAgent([frame]), "A2A");
    const response = await post(url, "/invocations", { agentName: "orders", prompt: "hi" });
    expect(await response.text()).toBe(`data: ${JSON.stringify(expected)}\n\n`);
  });

  test("drops a task frame that carries no renderable parts", async () => {
    const { url } = await inspectorFor(
      sseAgent([JSON.stringify({ result: { kind: "task" } })]),
      "A2A",
    );
    const response = await post(url, "/invocations", { agentName: "orders", prompt: "hi" });
    expect(await response.text()).toBe("");
  });

  test("passes a non-JSON A2A response through as plain text", async () => {
    const { url } = await inspectorFor(
      () => ({ status: 200, headers: { "Content-Type": "text/plain" }, body: "not json" }),
      "A2A",
    );
    const response = await post(url, "/invocations", { agentName: "orders", prompt: "hi" });
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toBe("not json");
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

  test("requires a prompt", async () => {
    const { url } = await inspectorFor(sseAgent([]), "AGUI");
    const response = await post(url, "/invocations", { agentName: "orders" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ success: false, error: "prompt is required" });
  });
});
