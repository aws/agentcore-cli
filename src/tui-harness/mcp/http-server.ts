/**
 * HTTP transport module for the TUI harness MCP server.
 *
 * Exposes the MCP server over Streamable HTTP on a single `/mcp` endpoint.
 * Each inbound `initialize` request creates a new stateful session with its
 * own `McpServer` instance (via `createServer()`) backed by a dedicated
 * `StreamableHTTPServerTransport`. Subsequent requests are routed to the
 * correct transport using the `mcp-session-id` header.
 *
 * Supported HTTP methods on `/mcp`:
 *   POST   — Handles `initialize` (creates a new session) and all subsequent
 *             JSON-RPC requests (routed by session ID).
 *   GET    — Opens an SSE stream for server-initiated messages.
 *   DELETE — Terminates a session and cleans up its resources.
 *
 * The server binds to `127.0.0.1` only (no external access) and registers
 * `SIGTERM`/`SIGINT` handlers for graceful shutdown.
 */
import { closeAllSessions, createServer } from './server.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A tracked MCP session with its transport and server instances. */
interface ManagedSession {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
}

// ---------------------------------------------------------------------------
// Session tracking
// ---------------------------------------------------------------------------

/**
 * Active HTTP sessions keyed by the `mcp-session-id` header value.
 *
 * Each session owns a unique `McpServer` + `StreamableHTTPServerTransport`
 * pair. The underlying `McpServer` shares the module-scoped PTY session pool
 * in `server.ts`, which is the desired behavior — all MCP server instances
 * operate on the same set of TUI sessions.
 */
const sessions = new Map<string, ManagedSession>();

// ---------------------------------------------------------------------------
// Request body parsing
// ---------------------------------------------------------------------------

/**
 * Read the full request body and parse it as JSON.
 *
 * Returns `undefined` for empty bodies (e.g. GET/DELETE requests) or when
 * the Content-Type is not `application/json`.
 */
function parseJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type'] ?? '';
    if (!contentType.includes('application/json')) {
      resolve(undefined);
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (raw.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error(`Failed to parse JSON body: ${err instanceof Error ? err.message : String(err)}`));
      }
    });
    req.on('error', (err: Error) => {
      reject(err);
    });
  });
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/**
 * Handle POST /mcp — JSON-RPC requests.
 *
 * If the body is an `initialize` request, a new session is created with a
 * fresh `McpServer` and `StreamableHTTPServerTransport`. Otherwise the
 * request is routed to the existing session identified by `mcp-session-id`.
 */
async function handlePost(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await parseJsonBody(req);

  // Determine if this is an initialize request so we can create a new session.
  const sessionId = req.headers['mcp-session-id'];

  if (isInitializeRequest(body)) {
    // Create a new transport and server for this session.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    const server = createServer();
    await server.connect(transport);

    // Process the initialize request first — the transport assigns the session
    // ID during handleRequest(), not at construction time.
    await transport.handleRequest(req, res, body);

    // Now the session ID is available.
    const transportSessionId = transport.sessionId;
    if (transportSessionId !== undefined) {
      const managed: ManagedSession = { transport, server };
      sessions.set(transportSessionId, managed);

      // Clean up when the transport closes (client disconnect, errors, etc.).
      transport.onclose = () => {
        sessions.delete(transportSessionId);
      };

      transport.onerror = (error: Error) => {
        process.stderr.write(`[mcp-http] Transport error (session ${transportSessionId}): ${error.message}\n`);
      };
    }

    return;
  }

  // Non-initialize request — route to the existing session.
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing mcp-session-id header.' }));
    return;
  }

  const managed = sessions.get(sessionId);
  if (!managed) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Session not found. It may have expired or been closed.' }));
    return;
  }

  await managed.transport.handleRequest(req, res, body);
}

/**
 * Handle GET /mcp — SSE stream for server-initiated messages.
 *
 * The client must include an `mcp-session-id` header to identify the session.
 */
async function handleGet(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const sessionId = req.headers['mcp-session-id'];

  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing mcp-session-id header.' }));
    return;
  }

  const managed = sessions.get(sessionId);
  if (!managed) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Session not found. It may have expired or been closed.' }));
    return;
  }

  await managed.transport.handleRequest(req, res);
}

/**
 * Handle DELETE /mcp — session termination.
 *
 * Closes the transport and removes the session from the tracking map.
 */
async function handleDelete(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const sessionId = req.headers['mcp-session-id'];

  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing mcp-session-id header.' }));
    return;
  }

  const managed = sessions.get(sessionId);
  if (!managed) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Session not found. It may have expired or been closed.' }));
    return;
  }

  // Let the transport handle the DELETE request (it sends the response).
  await managed.transport.handleRequest(req, res);

  // Clean up the session after the transport has processed the request.
  sessions.delete(sessionId);
  await managed.server.close();
}

// ---------------------------------------------------------------------------
// Request dispatcher
// ---------------------------------------------------------------------------

/**
 * Dispatch an incoming HTTP request to the appropriate handler.
 *
 * Extracted as a non-async function to satisfy Node's `createServer` callback
 * signature, which expects `(req, res) => void`.
 */
function dispatch(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  // Only serve the /mcp endpoint.
  if (url.pathname !== '/mcp') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found. The MCP endpoint is at /mcp.' }));
    return;
  }

  const handleRequest = async (): Promise<void> => {
    switch (req.method) {
      case 'POST':
        await handlePost(req, res);
        break;
      case 'GET':
        await handleGet(req, res);
        break;
      case 'DELETE':
        await handleDelete(req, res);
        break;
      default:
        res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'GET, POST, DELETE' });
        res.end(JSON.stringify({ error: `Method ${req.method} not allowed.` }));
        break;
    }
  };

  handleRequest().catch((err: unknown) => {
    // Guard against double-sending headers if the response is already in progress.
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error.' }));
    }
    process.stderr.write(`[mcp-http] Request error: ${err instanceof Error ? err.message : String(err)}\n`);
  });
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

/**
 * Start the MCP HTTP server on the specified port.
 *
 * The server listens on `127.0.0.1` (localhost only) and routes all traffic
 * through the `/mcp` endpoint. Registers `SIGTERM` and `SIGINT` handlers
 * for graceful shutdown.
 *
 * @param port - The TCP port to bind to.
 */
export async function startHttpServer(port: number): Promise<void> {
  const httpServer = createHttpServer(dispatch);

  // --- Graceful shutdown ---

  const shutdown = async (): Promise<void> => {
    process.stderr.write('[mcp-http] Shutting down...\n');

    // Close all transports so in-flight SSE streams terminate cleanly.
    const closePromises = Array.from(sessions.values()).map(async managed => {
      try {
        await managed.transport.close();
        await managed.server.close();
      } catch {
        // Best-effort cleanup — swallow errors from already-closed transports.
      }
    });
    await Promise.allSettled(closePromises);
    sessions.clear();

    // Close all PTY sessions managed by the server module.
    await closeAllSessions();

    // Close the HTTP server itself.
    httpServer.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => {
    void shutdown();
  });
  process.on('SIGINT', () => {
    void shutdown();
  });

  // --- Start listening ---

  return new Promise<void>((resolve, reject) => {
    httpServer.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(
          new Error(
            `Port ${port} is already in use. ` +
              'Try a different port with --port <number> or MCP_HARNESS_PORT=<number>.'
          )
        );
      } else {
        reject(err);
      }
    });

    httpServer.listen(port, '127.0.0.1', () => {
      process.stderr.write(`[mcp-http] MCP server listening at http://127.0.0.1:${port}/mcp\n`);
      resolve();
    });
  });
}
