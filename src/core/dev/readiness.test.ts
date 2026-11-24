import { describe, expect, test } from "bun:test";
import type { ProjectRuntime } from "../../projectSchemas/runtime";
import {
  HookPortReserver,
  type HttpFetch,
  runWarmupHook,
  WARMUP_TYPE_HEADER,
  waitForHealthyPing,
  warmupTarget,
} from "./readiness";

function runtime(build: ProjectRuntime["build"], httpPost?: { path: string; port?: number }) {
  return {
    name: "agent",
    build,
    protocol: "HTTP",
    entrypoint: "main.py",
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
    expect(warmupTarget(runtime("CodeZip", { path: "/warmup", port: 9300 }), 9100)).toEqual({
      path: "/warmup",
      port: 9300,
    });
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
