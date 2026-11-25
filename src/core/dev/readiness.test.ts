import { describe, expect, test } from "bun:test";
import type { ProjectRuntime } from "../../projectSchemas/runtime";
import {
  HookPortReserver,
  hooksConfigurationWarning,
  type HttpFetch,
  runWarmupHook,
  sharedHookPortError,
  WARMUP_TYPE_HEADER,
  waitForHealthyPing,
  waitUntilReady,
  warmupTarget,
} from "./readiness";

function runtime(
  build: ProjectRuntime["build"],
  httpPost?: { path: string; port?: number },
  overrides: Partial<ProjectRuntime> = {},
) {
  return {
    name: "agent",
    build,
    protocol: "HTTP",
    entrypoint: "main.py",
    ...overrides,
    codeLocation: "app/agent",
    ...(httpPost && { hooksConfiguration: { build: { warmup: { action: { httpPost } } } } }),
  } as ProjectRuntime;
}

type Call = { url: string; init: RequestInit };

/** A fetch that records each call and answers with the next scripted response (or throws it). */
function scriptedFetch(responses: Array<Response | Error>) {
  const calls: Call[] = [];
  const fetchImpl: HttpFetch = async (url, init) => {
    calls.push({ url, init });
    const next = responses.length > 1 ? responses.shift()! : responses[0]!;
    if (next instanceof Error) throw next;
    return next.clone() as Response;
  };
  return { fetchImpl, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("warmupTarget", () => {
  test("is undefined without a warmup hook", () => {
    expect(warmupTarget(runtime("CodeZip"), 9100)).toBeUndefined();
  });

  test.each(["CodeZip", "Container"] as const)(
    "%s: a hook without a port is served on the agent's dev port",
    (build) => {
      expect(warmupTarget(runtime(build, { path: "/warmup" }), 9100)).toEqual({
        path: "/warmup",
        port: 9100,
      });
    },
  );

  test.each(["CodeZip", "Container"] as const)(
    "%s: a hook on the serving port follows the dev port, wherever dev runs the agent",
    (build) => {
      expect(warmupTarget(runtime(build, { path: "/warmup", port: 8080 }), 9100)).toEqual({
        path: "/warmup",
        port: 9100,
      });
    },
  );

  test("CodeZip: a hook on its own port is reached on that local port", () => {
    const typescript = runtime(
      "CodeZip",
      { path: "/warmup", port: 9300 },
      { entrypoint: "main.ts" },
    );
    expect(warmupTarget(typescript, 9100)).toEqual({ path: "/warmup", port: 9300 });
  });

  test("Python CodeZip: a hook on its own port carries the uvicorn hint", () => {
    expect(warmupTarget(runtime("CodeZip", { path: "/warmup", port: 9300 }), 9100)).toEqual({
      path: "/warmup",
      port: 9300,
      hint: expect.stringContaining("HookConfig(port=...) isn't served"),
    });
  });

  test("a path without a leading slash is refused before dev builds a URL from it", () => {
    expect(() => warmupTarget(runtime("CodeZip", { path: "warmup" }), 9100)).toThrow(
      `Runtime 'agent' has warmup hook path "warmup", which must start with "/" (for example "/warmup").`,
    );
  });

  test("MCP: any /ping response counts, as it does for the service", () => {
    const mcp = runtime("CodeZip", { path: "/warmup" }, { protocol: "MCP" });
    expect(warmupTarget(mcp, 8000)).toEqual({ path: "/warmup", port: 8000, anyPingResponse: true });
  });

  test("A2A still has to report Healthy", () => {
    const a2a = runtime("CodeZip", { path: "/warmup" }, { protocol: "A2A" });
    expect(warmupTarget(a2a, 9000)).toEqual({ path: "/warmup", port: 9000 });
  });

  test("Container: a hook on the serving port goes through the dev port mapping", () => {
    expect(warmupTarget(runtime("Container", { path: "/warmup", port: 8080 }), 9100)).toEqual({
      path: "/warmup",
      port: 9100,
    });
  });

  test("Container: a hook on its own port goes through its mapped host port", () => {
    expect(warmupTarget(runtime("Container", { path: "/warmup", port: 9300 }), 9100, 9301)).toEqual(
      {
        path: "/warmup",
        port: 9301,
        viaContainerMapping: true,
      },
    );
  });

  test("Container: a hook on its own port without a mapped host port is refused with the fix", () => {
    expect(() => warmupTarget(runtime("Container", { path: "/warmup", port: 9300 }), 9100)).toThrow(
      /port 9300, which agentcore dev can't reach inside a container[\s\S]*serving port \(8080\)/,
    );
  });
});

describe("waitForHealthyPing", () => {
  test("retries until /ping reports Healthy", async () => {
    const { fetchImpl, calls } = scriptedFetch([
      new Error("ECONNREFUSED"),
      json({ status: "Starting" }),
      new Response("unavailable", { status: 503 }),
      json({ status: "Healthy" }),
    ]);
    await waitForHealthyPing(9100, new AbortController().signal, fetchImpl, 1);
    expect(calls.map((call) => [call.url, call.init.method])).toEqual(
      Array(4).fill(["http://127.0.0.1:9100/ping", "GET"]),
    );
  });

  test.each(["HealthyBusy", "healthy"])("accepts %s, in any case", async (status) => {
    const { fetchImpl } = scriptedFetch([json({ status })]);
    await waitForHealthyPing(9100, new AbortController().signal, fetchImpl, 1);
  });

  test("with anyResponse, a 404 from a server without /ping counts as ready", async () => {
    const { fetchImpl, calls } = scriptedFetch([
      new Error("ECONNREFUSED"),
      new Response("bad gateway", { status: 502 }),
      new Response("too many", { status: 429 }),
      new Response("not found", { status: 404 }),
    ]);
    await waitForHealthyPing(8000, new AbortController().signal, fetchImpl, 1, 1_000, true);
    expect(calls).toHaveLength(4);
  });

  test("with anyResponse, only 502 and 429 keep it waiting", async () => {
    const { fetchImpl } = scriptedFetch([new Response("bad gateway", { status: 502 })]);
    await expect(
      waitForHealthyPing(8000, new AbortController().signal, fetchImpl, 1, 20, true),
    ).rejects.toThrow("GET /ping on port 8000 got no response other than 502 or 429 within 0.02s.");
  });

  test("gives up at a fixed deadline, however much the agent logs meanwhile", async () => {
    const { fetchImpl } = scriptedFetch([new Response("not found", { status: 404 })]);
    await expect(
      waitForHealthyPing(9100, new AbortController().signal, fetchImpl, 1, 20),
    ).rejects.toThrow("GET /ping on port 9100 did not report Healthy within 0.02s.");
  });
});

describe("HookPortReserver", () => {
  const free = async () => true;

  test("prefers the hook's own number and skips ports dev already uses", async () => {
    const reserver = new HookPortReserver(free, new AbortController().signal, [9300]);
    expect(await reserver.reserve(9300)).toBe(9301);
    expect(await reserver.reserve(9400)).toBe(9400);
  });

  test("never hands out one port twice, even to agents starting together", async () => {
    const reserver = new HookPortReserver(free, new AbortController().signal);
    const ports = await Promise.all([reserver.reserve(9300), reserver.reserve(9300)]);
    expect(ports.sort()).toEqual([9300, 9301]);
  });
});

describe("runWarmupHook", () => {
  const target = { path: "/warmup", port: 9100 };

  test("sends memory then disk as the service does: POST, the type header, no body", async () => {
    const { fetchImpl, calls } = scriptedFetch([json({ status: "ok" })]);
    const announced: string[] = [];
    await runWarmupHook(target, new AbortController().signal, fetchImpl, (type) =>
      announced.push(type),
    );
    expect(announced).toEqual(["memory", "disk"]);
    expect(calls.map((call) => call.url)).toEqual([
      "http://127.0.0.1:9100/warmup",
      "http://127.0.0.1:9100/warmup",
    ]);
    for (const [index, type] of ["memory", "disk"].entries()) {
      const { init } = calls[index]!;
      expect(init.method).toBe("POST");
      expect(init.headers).toEqual({ [WARMUP_TYPE_HEADER]: type });
      expect(init.body).toBeUndefined();
    }
  });

  test("fails on a non-2xx response with the call, status and body", async () => {
    const { fetchImpl, calls } = scriptedFetch([
      json({ status: "ok" }),
      new Response('{"error": "disk warmup failed"}', { status: 500 }),
    ]);
    await expect(runWarmupHook(target, new AbortController().signal, fetchImpl)).rejects.toThrow(
      'The warmup disk call (POST /warmup on port 9100) returned 500: {"error": "disk warmup failed"}.',
    );
    expect(calls).toHaveLength(2);
  });

  test("hints at the container loopback when a mapped hook refuses the connection", async () => {
    const { fetchImpl } = scriptedFetch([new Error("Unable to connect")]);
    await expect(
      runWarmupHook(
        { ...target, viaContainerMapping: true },
        new AbortController().signal,
        fetchImpl,
      ),
    ).rejects.toThrow(
      /failed: Unable to connect\. If the hook listens only on the container's loopback/,
    );
  });

  test("fails when the calls outlast the shared budget", async () => {
    const hanging: HttpFetch = (_url, init) =>
      new Promise((_resolve, reject) =>
        init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true }),
      );
    await expect(
      runWarmupHook(target, new AbortController().signal, hanging, () => {}, 20),
    ).rejects.toThrow(
      "The warmup memory call (POST /warmup on port 9100) did not finish within the 0.02s warmup budget.",
    );
  });
});

describe("hooksConfigurationWarning", () => {
  const named = (hooksConfiguration: unknown) =>
    ({ name: "agent", hooksConfiguration }) as Pick<ProjectRuntime, "name" | "hooksConfiguration">;

  test.each([
    ["PascalCase keys", { Build: { Warmup: { Action: { HttpPost: { Path: "/warmup" } } } } }],
    ["a warmUp typo", { build: { warmUp: { action: { httpPost: { path: "/warmup" } } } } }],
    ["a build without a warmup", { build: {} }],
  ])("warns about %s, which dev would silently skip", (_case, hooks) => {
    expect(hooksConfigurationWarning(named(hooks))).toContain(
      "Runtime 'agent' has a hooksConfiguration without build.warmup.action.httpPost.path",
    );
  });

  test.each([
    ["a recognized hook", { build: { warmup: { action: { httpPost: { path: "/warmup" } } } } }],
    ["no hooks", undefined],
    ["an empty object", {}],
  ])("stays quiet for %s", (_case, hooks) => {
    expect(hooksConfigurationWarning(named(hooks))).toBeUndefined();
  });
});

describe("sharedHookPortError", () => {
  const hooked = (name: string, build: ProjectRuntime["build"], port?: number) => ({
    ...runtime(build, { path: "/warmup", ...(port !== undefined && { port }) }),
    name,
  });

  test("names CodeZip agents whose hooks share their own port", () => {
    expect(
      sharedHookPortError([hooked("ta", "CodeZip", 9000), hooked("tb", "CodeZip", 9000)]),
    ).toContain("('ta' and 'tb' on port 9000)");
  });

  test.each([
    ["different ports", [hooked("ta", "CodeZip", 9000), hooked("tb", "CodeZip", 9001)]],
    ["hooks on the serving port", [hooked("ta", "CodeZip", 8080), hooked("tb", "CodeZip")]],
    [
      "containers, which get their own host ports",
      [hooked("ta", "Container", 9000), hooked("tb", "Container", 9000)],
    ],
  ])("is undefined for %s", (_case, runtimes) => {
    expect(sharedHookPortError(runtimes)).toBeUndefined();
  });
});

describe("waitUntilReady", () => {
  test("adds the target's hint to a startup failure, and warns with it first", async () => {
    const statuses: string[] = [];
    await expect(
      waitUntilReady({
        name: "agent",
        devPort: 8080,
        warmup: { path: "/warmup", port: 9000, hint: "Leave the port unset." },
        waitForPort: async () => {
          throw new Error("Agent did not accept connections on port 8080 within 120s.");
        },
        signal: new AbortController().signal,
        fetchImpl: scriptedFetch([json({})]).fetchImpl,
        onStatus: (message) => statuses.push(message),
      }),
    ).rejects.toThrow(
      "Agent did not accept connections on port 8080 within 120s. Leave the port unset.",
    );
    expect(statuses).toEqual(["Warning: Leave the port unset."]);
  });
});
