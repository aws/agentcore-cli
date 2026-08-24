/**
 * The Agent Inspector request handler: a pure request → response function the
 * dev command composes with io/startHttpServer. It ports the reference
 * WebUIServer's security model (DNS-rebinding Host check, server-side origin
 * allowlist, X-Agentcore-Local on POSTs, CORS preflight) and the routes the SPA
 * calls this layer: status, on-demand start, trace reads, and the static SPA.
 * Agent-proxy routes (invocations, MCP, A2A, resources) register in a later PR.
 */
import { ResourceNotFoundError } from "../../../errors";
import type { HttpRequest, HttpRequestHandler, HttpResponse } from "../../../io/httpServer";
import { apiError, asString, errorMessage, json, parseJsonBody, parseTimeParam } from "./respond";
import type { InspectorDeps } from "./types";

/** Origins the Vite dev server uses for the frontend HMR workflow. */
const DEV_SERVER_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"];

/** Loopback Host headers the DNS-rebinding guard accepts, port already stripped. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Newest traces returned per list poll — bounds a payload that carries full spans per row. */
const TRACE_LIST_LIMIT = 200;

/** CSP for served HTML, blocking inline-script injection from agent responses. */
const CSP_HEADER =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self' data:";

export function createInspectorHandler(deps: InspectorDeps): HttpRequestHandler {
  return async (request) => {
    // DNS rebinding protection — a custom domain resolving to 127.0.0.1 would
    // bypass origin checks, so only loopback Host headers are accepted.
    const host = request.headers.host ?? "";
    const hostname = host.replace(/:\d+$/, "");
    if (!LOOPBACK_HOSTS.has(hostname)) return forbidden("Forbidden");

    // Server-side origin validation — CORS headers alone only stop the browser
    // from reading responses; the request's side effects (starting agents,
    // invoking with AWS credentials) must be blocked before any handler runs.
    const origin = asString(request.headers.origin);
    const allowedOrigins = [`http://${host}`, ...DEV_SERVER_ORIGINS];
    if (origin && !allowedOrigins.includes(origin)) return forbidden("Forbidden");
    const cors = corsHeaders(origin, allowedOrigins);

    if (request.method === "OPTIONS") return { status: 204, headers: cors };

    // Require a custom header on all POSTs: it forces a CORS preflight (which
    // the origin check blocks cross-origin), closing the simple-form-POST gap.
    if (request.method === "POST" && !request.headers["x-agentcore-local"]) {
      return withHeaders(forbidden("Forbidden: missing X-Agentcore-Local header"), cors);
    }

    const response = await route(deps, request);
    return withHeaders(response, cors);
  };
}

async function route(deps: InspectorDeps, request: HttpRequest): Promise<HttpResponse> {
  const url = new URL(request.url, "http://localhost");
  const { pathname } = url;
  const { method } = request;

  if (method === "GET" && pathname === "/api/status") return handleStatus(deps);
  if (method === "GET" && pathname === "/api/traces") return handleListTraces(deps, url);
  if (method === "GET" && pathname.startsWith("/api/traces/")) return handleGetTrace(deps, url);
  if (method === "POST" && pathname === "/api/start") return handleStart(deps, request);
  if (method === "GET" && !pathname.startsWith("/api/")) {
    const asset = await serveAsset(deps, pathname);
    if (asset) return asset;
  }
  return apiError(404, "Not Found");
}

/** GET /api/status — available agents, running ports, and per-agent errors. */
function handleStatus(deps: InspectorDeps): HttpResponse {
  const snapshot = deps.supervisor.snapshot();
  // The literal is the wire contract — the SPA depends on these exact field names.
  const status = {
    mode: "dev",
    agents: snapshot.map(({ name, buildType, protocol }) => ({ name, buildType, protocol })),
    harnesses: (deps.project?.spec.harnesses ?? []).map(({ name }) => ({ name })),
    running: snapshot
      .filter((agent) => agent.phase === "running" && agent.port !== undefined)
      .map(({ name, port }) => ({ name, port: port! })),
    errors: snapshot
      .filter((agent) => agent.error !== undefined)
      .map(({ name, error }) => ({ name, message: error! })),
    selectedAgent: deps.selectedAgent,
  };
  return json(200, status);
}

/** POST /api/start — start an agent on demand; concurrent starts share one attempt. */
async function handleStart(deps: InspectorDeps, request: HttpRequest): Promise<HttpResponse> {
  const agentName = asString(parseJsonBody(request.body)?.agentName);
  if (!agentName) return apiError(400, "agentName is required");

  try {
    const { name, port } = await deps.supervisor.start(agentName);
    return json(200, { success: true, name, port });
  } catch (error) {
    const status = error instanceof ResourceNotFoundError ? 404 : 500;
    return json(status, { success: false, name: agentName, port: 0, error: errorMessage(error) });
  }
}

/** GET /api/traces?agentName=xxx — recent local OTEL traces. */
async function handleListTraces(deps: InspectorDeps, url: URL): Promise<HttpResponse> {
  if (!deps.traces) return apiError(404, "Traces are not available");

  const startTime = parseTimeParam(url, "startTime");
  if (startTime.error) return startTime.error;
  const endTime = parseTimeParam(url, "endTime");
  if (endTime.error) return endTime.error;

  try {
    const traces = await deps.traces.list({
      serviceName: url.searchParams.get("agentName") ?? undefined,
      startTime: startTime.value,
      endTime: endTime.value,
      limit: TRACE_LIST_LIMIT,
    });
    return json(200, { success: true, traces });
  } catch {
    return apiError(500, "Failed to list traces");
  }
}

/** GET /api/traces/:traceId — full span and log data for one local trace. */
async function handleGetTrace(deps: InspectorDeps, url: URL): Promise<HttpResponse> {
  if (!deps.traces) return apiError(404, "Traces are not available");

  const traceId = decodeURIComponent(url.pathname.slice("/api/traces/".length));
  if (!traceId) return apiError(400, "traceId is required in the URL path");

  try {
    const detail = await deps.traces.get(traceId);
    if (!detail) return apiError(404, "Trace not found");
    return json(200, { success: true, ...detail });
  } catch {
    return apiError(500, "Failed to get trace");
  }
}

/** Serve a static SPA asset, falling back to index.html for client-side routes. */
async function serveAsset(
  deps: InspectorDeps,
  pathname: string,
): Promise<HttpResponse | undefined> {
  if (!deps.assets) return undefined;
  const asset = (await deps.assets.read(pathname)) ?? (await deps.assets.read("/index.html"));
  if (!asset) return undefined;
  return {
    status: 200,
    headers: {
      "Content-Type": asset.contentType,
      ...(asset.contentType.includes("text/html") && { "Content-Security-Policy": CSP_HEADER }),
    },
    body: Buffer.from(asset.body),
  };
}

function forbidden(message: string): HttpResponse {
  return { status: 403, headers: { "Content-Type": "text/plain" }, body: message };
}

function corsHeaders(origin: string | undefined, allowedOrigins: string[]): Record<string, string> {
  const allowedOrigin = origin && allowedOrigins.includes(origin) ? origin : allowedOrigins[0]!;
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Agentcore-Local, Mcp-Session-Id",
    "Access-Control-Expose-Headers": "Mcp-Session-Id, x-session-id",
    Vary: "Origin",
  };
}

function withHeaders(response: HttpResponse, headers: Record<string, string>): HttpResponse {
  return { ...response, headers: { ...headers, ...response.headers } };
}
