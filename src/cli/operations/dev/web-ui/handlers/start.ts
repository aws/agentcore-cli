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

  // A2A agents use a fixed framework port (9000) that can't be overridden via env vars —
  // serve_a2a() accepts port as a function parameter, not from the environment.
  // MCP agents (FastMCP) also use a fixed port: FastMCP.__init__ passes port=8000 as a
  // pydantic BaseSettings init kwarg, which takes priority over the FASTMCP_PORT env var
  // we set. So MCP agents always bind to 8000 regardless of environment configuration.
  const isA2A = config.protocol === 'A2A';
  const isMCP = config.protocol === 'MCP';
  const targetPort = isA2A ? 9000 : isMCP ? 8000 : ctx.options.uiPort + 1 + (agentIndex >= 0 ? agentIndex : 0);
  const agentPort = await findAvailablePort(targetPort);
  if (isA2A && agentPort !== 9000) {
    return {
      success: false,
      name: agentName,
      port: 0,
      error: `Port 9000 is in use. A2A agents require port 9000.`,
    };
  }
  if (isMCP && agentPort !== 8000) {
    return {
      success: false,
      name: agentName,
      port: 0,
      error: `Port 8000 is in use. MCP agents require port 8000 (FastMCP default).`,
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
  const agentEnvVars = { ...baseEnvVars, OTEL_SERVICE_NAME: agentName };

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
