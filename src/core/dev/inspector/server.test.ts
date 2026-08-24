import { afterEach, describe, expect, test } from "bun:test";
import type { Project } from "../../../handlers/project/types";
import { ProjectSpecSchema } from "../../../projectSchemas/project";
import { ServerFarm, fakeAssets, fakeSupervisor, get, post, runningAgent } from "./testkit";
import type { InspectorDeps } from "./types";

const farm = new ServerFarm();
afterEach(() => farm.close());

function deps(overrides: Partial<InspectorDeps> = {}): InspectorDeps {
  return { supervisor: fakeSupervisor(), ...overrides };
}

function project(): Project {
  return {
    name: "Demo",
    rootPath: "/workspace/demo",
    spec: ProjectSpecSchema.parse({
      name: "Demo",
      version: 1,
      managedBy: "CDK",
      harnesses: [{ name: "support", path: "harness/support" }],
    }),
  };
}

describe("createInspectorHandler security", () => {
  test.each([
    {
      name: "a non-loopback Host header",
      run: (url: string) => get(url, "/api/status", { Host: "evil.example.com" }),
      body: "Forbidden",
    },
    {
      name: "a cross-origin request from outside the allowlist",
      run: (url: string) => get(url, "/api/status", { Origin: "https://evil.example.com" }),
    },
    {
      name: "a POST missing the X-Agentcore-Local header",
      run: (url: string) =>
        fetch(`${url}/api/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agentName: "orders" }),
        }),
      body: "Forbidden: missing X-Agentcore-Local header",
    },
  ])("rejects $name with 403", async ({ run, body }) => {
    const { url } = await farm.inspector(deps());
    const response = await run(url);
    expect(response.status).toBe(403);
    if (body !== undefined) expect(await response.text()).toBe(body);
  });

  test("accepts an IPv6 loopback Host header", async () => {
    const { url } = await farm.inspector(deps());
    const response = await get(url, "/api/status", { Host: "[::1]:9000" });
    expect(response.status).toBe(200);
  });

  test("allows the Vite dev-server origin and echoes it in CORS headers", async () => {
    const { url } = await farm.inspector(deps());
    const response = await get(url, "/api/status", { Origin: "http://localhost:5173" });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    expect(response.headers.get("access-control-expose-headers")).toBe(
      "Mcp-Session-Id, x-session-id",
    );
  });

  test("answers CORS preflight with 204 and the allow headers", async () => {
    const { url } = await farm.inspector(deps());
    const response = await fetch(`${url}/api/start`, {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:5173" },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-methods")).toBe("GET, POST, OPTIONS");
    expect(response.headers.get("access-control-allow-headers")).toBe(
      "Content-Type, X-Agentcore-Local, Mcp-Session-Id",
    );
  });
});

describe("GET /api/status", () => {
  test("reports agents, running ports, errors, and harness names", async () => {
    const supervisor = fakeSupervisor({
      agents: [
        runningAgent("orders", 9001),
        {
          name: "billing",
          buildType: "Container",
          protocol: "MCP",
          phase: "failed",
          error: "boom",
        },
      ],
    });
    const { url } = await farm.inspector(
      deps({ supervisor, project: project(), selectedAgent: "orders" }),
    );

    const response = await get(url, "/api/status");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      mode: "dev",
      agents: [
        { name: "orders", buildType: "CodeZip", protocol: "HTTP" },
        { name: "billing", buildType: "Container", protocol: "MCP" },
      ],
      harnesses: [{ name: "support" }],
      running: [{ name: "orders", port: 9001 }],
      errors: [{ name: "billing", message: "boom" }],
      selectedAgent: "orders",
    });
  });
});

describe("POST /api/start", () => {
  test("starts the agent and returns its port", async () => {
    const started: string[] = [];
    const supervisor = fakeSupervisor({
      start: async (name) => {
        started.push(name);
        return { name, port: 9101 };
      },
    });
    const { url } = await farm.inspector(deps({ supervisor }));

    const response = await post(url, "/api/start", { agentName: "orders" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, name: "orders", port: 9101 });
    expect(started).toEqual(["orders"]);
  });

  test("an unknown agent yields a 404 error envelope", async () => {
    const { url } = await farm.inspector(deps());
    const response = await post(url, "/api/start", { agentName: "ghost" });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      success: false,
      name: "ghost",
      port: 0,
      error: "Agent 'ghost' was not found.",
    });
  });

  test("a startup failure yields a 500 error envelope", async () => {
    const supervisor = fakeSupervisor({
      start: () => Promise.reject(new Error("port exhausted")),
    });
    const { url } = await farm.inspector(deps({ supervisor }));
    const response = await post(url, "/api/start", { agentName: "orders" });
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ success: false, error: "port exhausted" });
  });

  test("requires agentName", async () => {
    const { url } = await farm.inspector(deps());
    const response = await post(url, "/api/start", {});
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ success: false, error: "agentName is required" });
  });
});

describe("GET /api/traces", () => {
  const traces = () => {
    const calls: { list: unknown[]; get: string[] } = { list: [], get: [] };
    return {
      calls,
      source: {
        list: async (options?: unknown) => {
          calls.list.push(options);
          return [{ traceId: "abc", spanCount: "2" }];
        },
        get: async (traceId: string) => {
          calls.get.push(traceId);
          return traceId === "abc"
            ? { resourceSpans: [{ spans: [] }], resourceLogs: [] }
            : undefined;
        },
      },
    };
  };

  test("lists traces filtered by agentName and time range, capped to the newest", async () => {
    const fake = traces();
    const { url } = await farm.inspector(deps({ traces: fake.source }));
    const response = await get(url, "/api/traces?agentName=orders&startTime=100&endTime=200");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      traces: [{ traceId: "abc", spanCount: "2" }],
    });
    expect(fake.calls.list).toEqual([
      { serviceName: "orders", startTime: 100, endTime: 200, limit: 200 },
    ]);
  });

  test("rejects a non-numeric startTime", async () => {
    const { url } = await farm.inspector(deps({ traces: traces().source }));
    const response = await get(url, "/api/traces?startTime=yesterday");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      success: false,
      error: "startTime must be a number (epoch milliseconds)",
    });
  });

  test("returns one trace's spans and logs by id", async () => {
    const { url } = await farm.inspector(deps({ traces: traces().source }));
    const response = await get(url, "/api/traces/abc");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      resourceSpans: [{ spans: [] }],
      resourceLogs: [],
    });
  });

  test("decodes a percent-encoded trace id before lookup", async () => {
    const fake = traces();
    const { url } = await farm.inspector(deps({ traces: fake.source }));
    await get(url, "/api/traces/trace%2F42");
    expect(fake.calls.get).toEqual(["trace/42"]);
  });

  test("does not match a path that merely prefixes /api/traces", async () => {
    const { url } = await farm.inspector(deps({ traces: traces().source }));
    const response = await get(url, "/api/tracesXYZ");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ success: false, error: "Not Found" });
  });

  test("an unknown trace id yields 404", async () => {
    const { url } = await farm.inspector(deps({ traces: traces().source }));
    const response = await get(url, "/api/traces/missing");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ success: false, error: "Trace not found" });
  });

  test("answers 404 when the trace source is absent", async () => {
    const { url } = await farm.inspector(deps());
    const response = await get(url, "/api/traces");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ success: false, error: "Traces are not available" });
  });
});

describe("static SPA serving", () => {
  const assets = () =>
    fakeAssets({
      "/index.html": { body: "<html>spa</html>", contentType: "text/html" },
      "/assets/app.js": { body: "console.log(1)", contentType: "application/javascript" },
    });

  test("serves an existing asset with its content type", async () => {
    const { url } = await farm.inspector(deps({ assets: assets() }));
    const response = await get(url, "/assets/app.js");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/javascript");
    expect(await response.text()).toBe("console.log(1)");
  });

  test("falls back to index.html for client-side routes, with a CSP header", async () => {
    const { url } = await farm.inspector(deps({ assets: assets() }));
    const response = await get(url, "/chat/session-1");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<html>spa</html>");
    expect(response.headers.get("content-security-policy")).toContain("script-src 'self'");
  });

  test("unknown /api paths get a JSON 404 instead of the SPA", async () => {
    const { url } = await farm.inspector(deps({ assets: assets() }));
    const response = await get(url, "/api/nope");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ success: false, error: "Not Found" });
  });

  test("404s when no assets are available", async () => {
    const { url } = await farm.inspector(deps());
    const response = await get(url, "/");
    expect(response.status).toBe(404);
  });
});
