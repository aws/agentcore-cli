import { afterEach, describe, expect, test } from "bun:test";
import type { HttpRequest } from "../../../io/httpServer";
import { ServerFarm, fakeSupervisor, get, post, runningAgent } from "./testkit";

const farm = new ServerFarm();
afterEach(() => farm.close());

describe("POST /api/mcp (local)", () => {
  test("forwards JSON-RPC to the agent's /mcp endpoint and passes the session id both ways", async () => {
    const seen: HttpRequest[] = [];
    const agent = await farm.serve((request) => {
      seen.push(request);
      return {
        status: 200,
        headers: { "Content-Type": "application/json", "Mcp-Session-Id": "mcp-2" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }),
      };
    });
    const supervisor = fakeSupervisor({ agents: [runningAgent("orders", agent.port, "MCP")] });
    const { url } = await farm.inspector({ supervisor });

    const response = await post(url, "/api/mcp", {
      agentName: "orders",
      sessionId: "mcp-1",
      body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      result: { jsonrpc: "2.0", id: 1, result: { tools: [] } },
      sessionId: "mcp-2",
    });
    expect(seen[0]?.url).toBe("/mcp");
    expect(seen[0]?.headers["mcp-session-id"]).toBe("mcp-1");
    expect(JSON.parse(seen[0]!.body.toString())).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });
  });

  test("requires agentName and body", async () => {
    const { url } = await farm.inspector({ supervisor: fakeSupervisor() });
    expect(await (await post(url, "/api/mcp", { body: { method: "initialize" } })).json()).toEqual({
      success: false,
      error: "agentName is required",
    });
    expect(await (await post(url, "/api/mcp", { agentName: "orders" })).json()).toEqual({
      success: false,
      error: "body is required",
    });
  });

  test("answers 400 when the agent is not running", async () => {
    const { url } = await farm.inspector({ supervisor: fakeSupervisor() });
    const response = await post(url, "/api/mcp", { agentName: "orders", body: { method: "x" } });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      success: false,
      error: 'Agent "orders" is not running',
    });
  });
});

describe("GET /api/a2a/agent-card", () => {
  test("fetches the card from the running agent's well-known route", async () => {
    const agent = await farm.serve((request) =>
      request.url === "/.well-known/agent.json"
        ? {
            status: 200,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: "orders", version: "1.0" }),
          }
        : { status: 404 },
    );
    const supervisor = fakeSupervisor({ agents: [runningAgent("orders", agent.port, "A2A")] });
    const { url } = await farm.inspector({ supervisor });

    const response = await get(url, "/api/a2a/agent-card?agentName=orders");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      card: { name: "orders", version: "1.0" },
    });
  });

  test("requires agentName and a running agent", async () => {
    const { url } = await farm.inspector({ supervisor: fakeSupervisor() });
    expect(await (await get(url, "/api/a2a/agent-card")).json()).toEqual({
      success: false,
      error: "agentName query parameter is required",
    });
    expect(await (await get(url, "/api/a2a/agent-card?agentName=orders")).json()).toEqual({
      success: false,
      error: 'Agent "orders" is not running',
    });
  });
});
