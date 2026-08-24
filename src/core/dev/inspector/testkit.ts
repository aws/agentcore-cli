/**
 * Test support for the Inspector server suites: fakes for every injected
 * dependency and helpers that run the real handler behind a real loopback
 * HTTP server. Imported only by the colocated *.test.ts files.
 */
import { ResourceNotFoundError } from "../../../errors";
import {
  startHttpServer,
  type HttpRequestHandler,
  type HttpServerHandle,
} from "../../../io/httpServer";
import { createInspectorHandler } from "./server";
import type { InspectorAgentStatus, InspectorDeps, InspectorSupervisor } from "./types";

export interface FakeSupervisorOptions {
  agents?: InspectorAgentStatus[];
  start?: (name: string) => Promise<{ name: string; port: number }>;
}

export function fakeSupervisor(options: FakeSupervisorOptions = {}): InspectorSupervisor {
  const agents = options.agents ?? [];
  return {
    snapshot: () => agents,
    start:
      options.start ??
      ((name) => Promise.reject(new ResourceNotFoundError(`Agent '${name}' was not found.`))),
    running: (name) => {
      const agent = agents.find((entry) => entry.name === name);
      if (agent?.phase !== "running" || agent.port === undefined) return undefined;
      return { port: agent.port, protocol: agent.protocol };
    },
  };
}

export function runningAgent(name: string, port: number, protocol = "HTTP"): InspectorAgentStatus {
  return { name, buildType: "CodeZip", protocol, phase: "running", port };
}

/** In-memory SPA assets keyed by path (e.g. "/index.html"). */
export function fakeAssets(files: Record<string, { body: string; contentType: string }>) {
  return {
    read: async (path: string) => {
      const file = files[path];
      if (!file) return undefined;
      return { body: new TextEncoder().encode(file.body), contentType: file.contentType };
    },
  };
}

/** Tracks started servers so a test can close them all in afterEach. */
export class ServerFarm {
  private readonly handles: HttpServerHandle[] = [];

  /** Start the Inspector itself over the given deps. */
  async inspector(deps: InspectorDeps): Promise<{ url: string; port: number }> {
    return this.serve(createInspectorHandler(deps));
  }

  /** Start a stub server (e.g. a fake agent) with an arbitrary handler. */
  async serve(handler: HttpRequestHandler): Promise<{ url: string; port: number }> {
    const handle = await startHttpServer(handler);
    this.handles.push(handle);
    return { url: `http://127.0.0.1:${handle.port}`, port: handle.port };
  }

  async close(): Promise<void> {
    await Promise.all(this.handles.splice(0).map((handle) => handle.close()));
  }
}

/** GET with a loopback Host header (fetch sets it from the URL automatically). */
export function get(base: string, path: string, headers: Record<string, string> = {}) {
  return fetch(`${base}${path}`, { headers });
}

/** POST JSON with the X-Agentcore-Local header the server requires. */
export function post(
  base: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Agentcore-Local": "1", ...headers },
    body: JSON.stringify(body),
  });
}
