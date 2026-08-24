import { afterEach, describe, expect, test } from "bun:test";
import type { HttpRequestHandler } from "../../../io/httpServer";
import { ServerFarm, fakeSupervisor, get, post, runningAgent } from "./testkit";

const farm = new ServerFarm();
afterEach(() => farm.close());

async function inspectorFor(handler: HttpRequestHandler) {
  const agent = await farm.serve(handler);
  const supervisor = fakeSupervisor({ agents: [runningAgent("orders", agent.port, "MCP")] });
  return farm.inspector({ supervisor });
}

describe("POST /api/mcp", () => {
  test("forwards the JSON-RPC body and returns the parsed result with the session id", async () => {
    const { url } = await inspectorFor((request) => {
      expect(request.url).toBe("/mcp");
      return {
        status: 200,
        headers: { "Content-Type": "application/json", "mcp-session-id": "mcp-1" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }),
      };
    });
    const response = await post(url, "/api/mcp", {
      agentName: "orders",
      body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      result: { jsonrpc: "2.0", id: 1, result: { tools: [] } },
      sessionId: "mcp-1",
    });
  });

  test.each([
    { name: "invalid JSON", body: "not json", expected: "Invalid JSON" },
    { name: "a missing agentName", body: { body: {} }, expected: "agentName is required" },
    { name: "a missing body", body: { agentName: "orders" }, expected: "body is required" },
  ])("rejects $name with 400", async ({ body, expected }) => {
    const { url } = await inspectorFor(() => ({ status: 200, body: "{}" }));
    const response = await fetch(`${url}/api/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Agentcore-Local": "1" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ success: false, error: expected });
  });

  test("rejects an agent that is not running with 400", async () => {
    const { url } = await farm.inspector({ supervisor: fakeSupervisor() });
    const response = await post(url, "/api/mcp", { agentName: "ghost", body: {} });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      success: false,
      error: 'Agent "ghost" is not running',
    });
  });

  test("returns 502 when the agent responds with an error status", async () => {
    const { url } = await inspectorFor(() => ({ status: 500, body: "down" }));
    const response = await post(url, "/api/mcp", { agentName: "orders", body: {} });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ success: false });
  });

  test("returns 502 when the response exceeds the size limit", async () => {
    const { url } = await inspectorFor(() => ({
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: "x".repeat(10 * 1024 * 1024 + 1),
    }));
    const response = await post(url, "/api/mcp", { agentName: "orders", body: {} });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      success: false,
      error: "MCP response exceeded the size limit",
    });
  });
});

describe("GET /api/a2a/agent-card", () => {
  test("returns the running agent's card", async () => {
    const { url } = await inspectorFor((request) => {
      expect(request.url).toBe("/.well-known/agent.json");
      return {
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "orders", version: "1.0" }),
      };
    });
    const response = await get(url, "/api/a2a/agent-card?agentName=orders");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      card: { name: "orders", version: "1.0" },
    });
  });

  test("requires the agentName query parameter", async () => {
    const { url } = await inspectorFor(() => ({ status: 200, body: "{}" }));
    const response = await get(url, "/api/a2a/agent-card");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      success: false,
      error: "agentName query parameter is required",
    });
  });

  test("returns 502 when the card is not available", async () => {
    const { url } = await inspectorFor(() => ({ status: 404, body: "missing" }));
    const response = await get(url, "/api/a2a/agent-card?agentName=orders");
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ success: false });
  });
});
