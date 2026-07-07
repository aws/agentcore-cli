import { type DevServerCallbacks, createDevServer, findAvailablePort } from '../../server';
import { waitForServerReady } from '../../utils';
import type { RouteContext } from './route-context';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * POST /api/start — start an agent server on demand.
 * Body: { agentName: string }
 */
export async function handleStart(
  ctx: RouteContext,
  req: IncomingMessage,
  res: ServerResponse,
  origin?: string
): Promise<void> {
  const body = await ctx.readBody(req);
  let agentName: string | undefined;
  try {
    const parsed = JSON.parse(body) as { agentName?: string };
    agentName = parsed.agentName;
  } catch {
    // fall through
  }

  if (!agentName) {
    ctx.setCorsHeaders(res, origin);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'agentName is required' }));
    return;
  }

  // Delegate to custom start handler if provided
  if (ctx.options.onStart) {
    const result = await ctx.options.onStart(agentName);
    ctx.setCorsHeaders(res, origin);
    res.writeHead(result.success ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  // Already running — return existing port
  const existing = ctx.runningAgents.get(agentName);
  if (existing) {
    ctx.setCorsHeaders(res, origin);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, name: agentName, port: existing.port }));
    return;
  }

  // If a start is already in flight for this agent, wait for it instead of spawning a duplicate
  const inflight = ctx.startingAgents.get(agentName);
  if (inflight) {
    const result = await inflight;
    ctx.setCorsHeaders(res, origin);
    res.writeHead(result.success ? 200 : 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  const startPromise = doStartAgent(ctx, agentName);
  ctx.startingAgents.set(agentName, startPromise);

  try {
    const result = await startPromise;
    ctx.setCorsHeaders(res, origin);
    res.writeHead(result.success ? 200 : 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } finally {
    ctx.startingAgents.delete(agentName);
  }
}

/**
 * Resolve the target port a web-UI-served agent should bind to.
 *
 * - A2A/MCP agents use their framework-fixed ports (9000 / 8000).
 * - When `-p`/`--port` was set explicitly (`agentBasePort !== undefined`), the
 *   *selected* runtime is honored literally (binds exactly `agentBasePort`, no
 *   offset). All other runtimes fall back to the default `uiPort + 1 + index`
 *   allocation, so an explicit `-p` never produces ports below the requested
 *   value or for runtimes the user didn't ask for.
 * - Otherwise every HTTP runtime is allocated `uiPort + 1 + index`.
 */
export function resolveAgentTargetPort(args: {
  protocol: string;
  agentName: string;
  agentIndex: number;
  uiPort: number;
  agentBasePort?: number;
  selectedAgent?: string;
}): number {
  const { protocol, agentName, agentIndex, uiPort, agentBasePort, selectedAgent } = args;
  if (protocol === 'A2A') return 9000;
  if (protocol === 'MCP') return 8000;
  const safeIndex = agentIndex >= 0 ? agentIndex : 0;
  if (agentBasePort !== undefined && agentName === selectedAgent) {
    return agentBasePort;
  }
  return uiPort + 1 + safeIndex;
}

/**
 * Actually start an agent server. Extracted so the result
 * can be shared across concurrent requests via startingAgents.
 */
async function doStartAgent(
  ctx: RouteContext,
  agentName: string
): Promise<{ success: boolean; name: string; port: number; error?: string }> {
  const getDevConfig = ctx.options.getDevConfig;
  if (!getDevConfig) {
    return { success: false, name: agentName, port: 0, error: 'Dev config factory not provided' };
  }

  const config = await getDevConfig(agentName);
  if (!config) {
    return { success: false, name: agentName, port: 0, error: `Agent "${agentName}" not found or not supported` };
  }

  const agentIndex = ctx.options.agents.findIndex(a => a.name === agentName);
  const { onLog } = ctx.options;

  // Several frameworks bind to a fixed port that ignores the PORT env var:
  //  - A2A: serve_a2a() accepts port as a function parameter, not from env → 9000
  //  - MCP (FastMCP): pydantic BaseSettings init kwarg overrides env → 8000
  // TS HTTP agents read PORT env var so we can assign any available port.
  // For Python HTTP agents, uvicorn takes --port as a CLI arg so we can assign any port.
  const isA2A = config.protocol === 'A2A';
  const isMCP = config.protocol === 'MCP';
  const fixedPort = isA2A ? 9000 : isMCP ? 8000 : undefined;
  const isTsHttp = !config.isPython && config.protocol === 'HTTP';
  const targetPort = resolveAgentTargetPort({
    protocol: config.protocol,
    agentName,
    agentIndex,
    uiPort: ctx.options.uiPort,
    agentBasePort: ctx.options.agentBasePort,
    selectedAgent: ctx.options.selectedAgent,
  });
  // An explicit -p must be honored literally for the selected runtime; if it's taken,
  // fail fast instead of silently rebinding (the silent-shift behavior #1079 removes).
  const portIsExplicit = ctx.options.agentBasePort !== undefined && agentName === ctx.options.selectedAgent;
  const agentPort = await findAvailablePort(targetPort);
  if (fixedPort && agentPort !== fixedPort) {
    const reason = isA2A ? 'A2A agents require port 9000.' : 'MCP agents require port 8000 (FastMCP default).';
    return {
      success: false,
      name: agentName,
      port: 0,
      error: `Port ${fixedPort} is in use. ${reason}`,
    };
  }
  if (portIsExplicit && agentPort !== targetPort) {
    return {
      success: false,
      name: agentName,
      port: 0,
      error: `Port ${targetPort} is in use. Free it or pass a different --port (no port is chosen automatically when --port is set explicitly).`,
    };
  }
  if (agentPort !== targetPort) {
    onLog?.('info', `[${agentName}] Port ${targetPort} in use, using ${agentPort}`);
  }

  // Collect error messages during startup so we can surface them to the frontend
  const errorMessages: string[] = [];

  const callbacks: DevServerCallbacks = {
    onLog: (level, msg) => {
      if (level === 'error') {
        errorMessages.push(msg);
        // Surface runtime errors to the frontend via /api/status.
        // Only update if the agent is already running (startup errors are
        // handled separately when start() returns null).
        if (ctx.runningAgents.has(agentName)) {
          ctx.agentErrors.set(agentName, { message: msg, timestamp: Date.now() });
        }
      }
      onLog?.(level === 'error' ? 'error' : 'info', `[${agentName}] ${msg}`);
    },
    onExit: code => {
      onLog?.('info', `[${agentName}] Server exited with code ${code ?? 0}`);
      ctx.runningAgents.delete(agentName);
      // Record error state when the server crashes after it was running
      if (code !== 0 && code !== null) {
        ctx.agentErrors.set(agentName, {
          message: errorMessages.length > 0 ? errorMessages.join('\n') : `Server exited with code ${code}`,
          timestamp: Date.now(),
        });
      }
    },
  };

  const baseEnvVars = ctx.options.getEnvVars ? await ctx.options.getEnvVars() : (ctx.options.envVars ?? {});
  const agentEnvVars = {
    ...baseEnvVars,
    OTEL_SERVICE_NAME: agentName,
    ...(isTsHttp ? { PORT: String(agentPort) } : {}),
  };

  const agentServer = createDevServer(config, {
    port: agentPort,
    envVars: agentEnvVars,
    callbacks,
  });

  // Clear any previous error for this agent before attempting start
  ctx.agentErrors.delete(agentName);

  const child = await agentServer.start();

  // start() returns null when prepare() fails (e.g. Docker not ready, missing Dockerfile)
  if (!child) {
    const errorMsg = errorMessages.length > 0 ? errorMessages.join('\n') : 'Agent server failed to start';
    ctx.agentErrors.set(agentName, { message: errorMsg, timestamp: Date.now() });
    return { success: false, name: agentName, port: 0, error: errorMsg };
  }

  // Wait for the server to accept connections before adding to runningAgents.
  // runningAgents gates /api/status, so adding early lets the frontend send
  // invocations before the server is ready.
  const ready = await waitForServerReady(agentPort);
  if (!ready) {
    const errorMsg =
      errorMessages.length > 0 ? errorMessages.join('\n') : 'Agent server started but is not accepting connections';
    ctx.agentErrors.set(agentName, { message: errorMsg, timestamp: Date.now() });
    return { success: false, name: agentName, port: 0, error: errorMsg };
  }

  ctx.runningAgents.set(agentName, { server: agentServer, port: agentPort, protocol: config.protocol });
  return { success: true, name: agentName, port: agentPort };
}
