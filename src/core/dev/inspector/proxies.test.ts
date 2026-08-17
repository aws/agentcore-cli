import { afterEach, describe, expect, test } from "bun:test";
import type { HttpRequest } from "../../../io/httpServer";
import { ServerFarm, fakeSupervisor, get, post, runningAgent } from "./testkit";
import type { InspectorDeps } from "./types";

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

describe("POST /api/mcp?target=deployed", () => {
  const mcpDeps = () => {
    const calls: [string, unknown][] = [];
    const deps: InspectorDeps = {
      supervisor: fakeSupervisor(),
      aws: {
        mcp: {
          initialize: async (args) => {
            calls.push(["initialize", args]);
            return { sessionId: "deployed-1" };
          },
          listTools: async (args) => {
            calls.push(["listTools", args]);
            return { tools: [{ name: "search" }] };
          },
          callTool: async (args) => {
            calls.push(["callTool", args]);
            return "tool output";
          },
        },
      },
    };
    return { deps, calls };
  };

  test("initialize returns the deployed MCP session id", async () => {
    const { deps, calls } = mcpDeps();
    const { url } = await farm.inspector(deps);
    const response = await post(url, "/api/mcp?target=deployed", {
      agentName: "orders",
      body: { jsonrpc: "2.0", method: "initialize" },
    });
    expect(await response.json()).toEqual({
      success: true,
      result: { jsonrpc: "2.0", result: {} },
      sessionId: "deployed-1",
    });
    expect(calls).toEqual([
      ["initialize", { agentName: "orders", targetName: undefined, sessionId: undefined }],
    ]);
  });

  test("tools/list and tools/call wrap the results in JSON-RPC envelopes", async () => {
    const { deps } = mcpDeps();
    const { url } = await farm.inspector(deps);

    const list = await post(url, "/api/mcp?target=deployed", {
      body: { method: "tools/list" },
    });
    expect(await list.json()).toEqual({
      success: true,
      result: { jsonrpc: "2.0", result: { tools: [{ name: "search" }] } },
    });

    const call = await post(url, "/api/mcp?target=deployed", {
      body: { method: "tools/call", params: { name: "search", arguments: { q: "x" } } },
    });
    expect(await call.json()).toEqual({
      success: true,
      result: {
        jsonrpc: "2.0",
        result: { content: [{ type: "text", text: "tool output" }] },
      },
    });
  });

  test("rejects unsupported methods and missing tool names", async () => {
    const { deps } = mcpDeps();
    const { url } = await farm.inspector(deps);
    expect(
      await (await post(url, "/api/mcp?target=deployed", { body: { method: "ping" } })).json(),
    ).toEqual({ success: false, error: "Unsupported MCP method: ping" });
    expect(
      await (
        await post(url, "/api/mcp?target=deployed", { body: { method: "tools/call", params: {} } })
      ).json(),
    ).toEqual({ success: false, error: "tools/call requires params.name" });
  });

  test("answers 404 when deployed MCP is not wired", async () => {
    const { url } = await farm.inspector({ supervisor: fakeSupervisor() });
    const response = await post(url, "/api/mcp?target=deployed", {
      body: { method: "initialize" },
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      success: false,
      error: "Deployed MCP is not available",
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

describe("memory routes", () => {
  const memoryDeps = () => {
    const calls: [string, unknown][] = [];
    const deps: InspectorDeps = {
      supervisor: fakeSupervisor(),
      aws: {
        memory: {
          list: async (args) => {
            calls.push(["list", args]);
            return { success: true, records: [] };
          },
          search: async (args) => {
            calls.push(["search", args]);
            return { success: true, records: [] };
          },
        },
      },
    };
    return { deps, calls };
  };

  test("GET /api/memory lists records for a namespace", async () => {
    const { deps, calls } = memoryDeps();
    const { url } = await farm.inspector(deps);
    const response = await get(url, "/api/memory?memoryName=recall&namespace=/users/u1/facts");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, records: [] });
    expect(calls).toEqual([
      ["list", { memoryName: "recall", strategyId: undefined, namespace: "/users/u1/facts" }],
    ]);
  });

  test("GET /api/memory validates the namespace selector", async () => {
    const { deps } = memoryDeps();
    const { url } = await farm.inspector(deps);
    expect(await (await get(url, "/api/memory?namespace=/x")).json()).toEqual({
      success: false,
      error: "memoryName query parameter is required",
    });
    expect(
      await (await get(url, "/api/memory?memoryName=recall&namespace=/x&namespacePath=/y")).json(),
    ).toEqual({
      success: false,
      error: "'namespace' and 'namespacePath' query parameters are mutually exclusive",
    });
    expect(await (await get(url, "/api/memory?memoryName=recall")).json()).toEqual({
      success: false,
      error: "either 'namespace' or 'namespacePath' query parameter is required",
    });
  });

  test("POST /api/memory/search runs a semantic search", async () => {
    const { deps, calls } = memoryDeps();
    const { url } = await farm.inspector(deps);
    const response = await post(url, "/api/memory/search", {
      memoryName: "recall",
      namespacePath: "/users",
      searchQuery: "favorite color",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, records: [] });
    expect(calls).toEqual([
      [
        "search",
        {
          memoryName: "recall",
          searchQuery: "favorite color",
          strategyId: undefined,
          namespacePath: "/users",
        },
      ],
    ]);
  });

  test("POST /api/memory/search requires a searchQuery", async () => {
    const { deps } = memoryDeps();
    const { url } = await farm.inspector(deps);
    const response = await post(url, "/api/memory/search", {
      memoryName: "recall",
      namespace: "/users/u1/facts",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ success: false, error: "searchQuery is required" });
  });

  test("memory routes answer 404 when the capability is not wired", async () => {
    const { url } = await farm.inspector({ supervisor: fakeSupervisor() });
    expect((await get(url, "/api/memory?memoryName=recall&namespace=/x")).status).toBe(404);
    expect(await (await get(url, "/api/memory?memoryName=recall&namespace=/x")).json()).toEqual({
      success: false,
      error: "Memory browsing is not available",
    });
    expect(
      await (
        await post(url, "/api/memory/search", {
          memoryName: "recall",
          namespace: "/x",
          searchQuery: "q",
        })
      ).json(),
    ).toEqual({ success: false, error: "Memory search is not available" });
  });
});

describe("cloudwatch trace routes", () => {
  const cloudwatchDeps = () => {
    const calls: [string, unknown][] = [];
    const deps: InspectorDeps = {
      supervisor: fakeSupervisor(),
      aws: {
        cloudwatchTraces: {
          list: async (args) => {
            calls.push(["list", args]);
            return { success: true, traces: [{ traceId: "abc123", timestamp: "t" }] };
          },
          get: async (args) => {
            calls.push(["get", args]);
            return { success: true, records: [], spans: [] };
          },
        },
      },
    };
    return { deps, calls };
  };

  test("lists traces for an agent with a time range", async () => {
    const { deps, calls } = cloudwatchDeps();
    const { url } = await farm.inspector(deps);
    const response = await get(url, "/api/cloudwatch-traces?agentName=orders&startTime=5");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      traces: [{ traceId: "abc123", timestamp: "t" }],
    });
    expect(calls).toEqual([
      ["list", { agentName: "orders", harnessName: undefined, startTime: 5, endTime: undefined }],
    ]);
  });

  test("requires exactly one of agentName or harnessName", async () => {
    const { deps } = cloudwatchDeps();
    const { url } = await farm.inspector(deps);
    expect(await (await get(url, "/api/cloudwatch-traces")).json()).toEqual({
      success: false,
      error: "Either agentName or harnessName query parameter is required",
    });
    expect(
      await (await get(url, "/api/cloudwatch-traces?agentName=a&harnessName=h")).json(),
    ).toEqual({ success: false, error: "Provide either agentName or harnessName, not both" });
  });

  test("gets one trace by id", async () => {
    const { deps, calls } = cloudwatchDeps();
    const { url } = await farm.inspector(deps);
    const response = await get(url, "/api/cloudwatch-traces/1-abc-DEF?harnessName=support");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, records: [], spans: [] });
    expect(calls).toEqual([
      [
        "get",
        {
          agentName: undefined,
          harnessName: "support",
          startTime: undefined,
          endTime: undefined,
          traceId: "1-abc-DEF",
        },
      ],
    ]);
  });

  test("rejects a non-hex trace id", async () => {
    const { deps } = cloudwatchDeps();
    const { url } = await farm.inspector(deps);
    const response = await get(url, "/api/cloudwatch-traces/..%2Fetc?agentName=orders");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ success: false, error: "Invalid trace ID format" });
  });

  test("answers 404 when the capability is not wired", async () => {
    const { url } = await farm.inspector({ supervisor: fakeSupervisor() });
    const response = await get(url, "/api/cloudwatch-traces?agentName=orders");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      success: false,
      error: "CloudWatch traces are not available",
    });
  });
});
