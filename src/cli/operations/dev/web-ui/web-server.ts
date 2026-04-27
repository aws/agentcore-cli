import type { DevConfig } from '../config';
import type { DevServer } from '../server';
import { type AgentError, type AgentInfo, WEB_UI_LOCAL_URL } from './constants';
import {
  type RouteContext,
  handleA2AAgentCard,
  handleGetTrace,
  handleInvocations,
  handleListMemoryRecords,
  handleListTraces,
  handleMcpProxy,
  handleResources,
  handleRetrieveMemoryRecords,
  handleStart,
  handleStatus,
} from './handlers';
import fs from 'node:fs';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
};

/** CSP header to block inline script injection from malicious agent responses. */
const CSP_HEADER =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self' data:";

/** Resolve the frontend dist directory. Returns null if not found. */
export function resolveUIDistDir(): string | null {
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.AGENT_INSPECTOR_PATH,
    // Bundled CLI: dist/cli/index.mjs → dist/agent-inspector/
    path.resolve(thisDir, '..', 'agent-inspector'),
    // npm package: @aws/agent-inspector/dist-assets/
    path.resolve(thisDir, '..', '..', '..', '..', '..', 'node_modules', '@aws', 'agent-inspector', 'dist-assets'),
    // Dev via tsx: src/cli/operations/dev/web-ui/ → src/assets/agent-inspector/
    path.resolve(thisDir, '..', '..', '..', '..', 'assets', 'agent-inspector'),
  ].filter((c): c is string => !!c);
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'index.html'))) return dir;
  }
  return null;
}

/**
 * Custom handler for POST /api/start.
 * Return a JSON-serializable response object. Throwing an error will send a 500.
 */
export type StartHandler = (
  agentName: string
) => Promise<{ success: boolean; name: string; port: number; error?: string }>;

/**
 * Custom handler for GET /api/traces.
 * Returns a list of recent traces for the given agent.
 */
export type ListTracesHandler = (
  agentName: string | undefined,
  startTime?: number,
  endTime?: number
) => Promise<{ success: boolean; traces?: unknown[]; error?: string }>;

/**
 * Custom handler for GET /api/traces/:traceId.
 * Returns the full trace data for a specific trace.
 */
export type GetTraceHandler = (
  agentName: string | undefined,
  traceId: string,
  startTime?: number,
  endTime?: number
) => Promise<{ success: boolean; resourceSpans?: unknown[]; resourceLogs?: unknown[]; error?: string }>;

/**
 * Custom handler for GET /api/memory.
 * Returns a list of memory records for a given memory + namespace.
 */
export type ListMemoryRecordsHandler = (
  memoryName: string,
  namespace: string,
  strategyId?: string
) => Promise<{ success: boolean; records?: unknown[]; error?: string }>;

/**
 * Custom handler for POST /api/memory/search.
 * Performs semantic search across memory records.
 */
export type RetrieveMemoryRecordsHandler = (
  memoryName: string,
  namespace: string,
  searchQuery: string,
  strategyId?: string
) => Promise<{ success: boolean; records?: unknown[]; error?: string }>;

export interface WebUIOptions {
  /** Server mode identifier (currently only 'dev' is used) */
  mode: 'dev';
  /** Port for the web UI server (API proxy) */
  uiPort: number;
  /** Available agents (metadata only — servers are started on demand) */
  agents: AgentInfo[];
  /** Dev config factory — called when an agent needs to be started. Required for dev mode, unused when onStart is provided. */
  getDevConfig?: (agentName: string) => DevConfig | null | Promise<DevConfig | null>;
  /** Env vars to pass to started agent servers */
  envVars?: Record<string, string>;
  /** Callback to reload env vars from .env.local. When provided, called on each agent start to pick up new keys. */
  getEnvVars?: () => Promise<Record<string, string>>;
  /** Path to the agentcore/ config directory */
  configRoot?: string;
  /** Callback when server starts listening */
  onReady?: (url: string) => void;
  /** Callback for log messages */
  onLog?: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** Custom start handler — overrides the default dev server start logic */
  onStart?: StartHandler;
  /** Custom handler for listing traces */
  onListTraces?: ListTracesHandler;
  /** Custom handler for getting a single trace */
  onGetTrace?: GetTraceHandler;
  /** Custom handler for listing memory records */
  onListMemoryRecords?: ListMemoryRecordsHandler;
  /** Custom handler for searching memory records */
  onRetrieveMemoryRecords?: RetrieveMemoryRecordsHandler;
  /** Agent to pre-select in the UI dropdown (set when --runtime is specified) */
  selectedAgent?: string;
  /** Callback to reload the agents list from config. When provided, the server watches agentcore.json and calls this on change. */
  reloadAgents?: () => Promise<AgentInfo[]>;
}

/**
 * Lightweight HTTP server that proxies requests to agent dev servers.
 * Agent servers are started on demand when the frontend selects an agent.
 * The chat UI is served as static files from the built frontend (agent-inspector).
 *
 * Route handlers are in ./handlers/ — this class owns lifecycle, CORS, and routing only.
 */
export class WebUIServer {
  private server: ReturnType<typeof createServer> | null = null;
  private configWatcher: fs.FSWatcher | null = null;
  /** Map of agentName → running agent server + port */
  private readonly runningAgents = new Map<string, { server: DevServer; port: number; protocol: string }>();
  /** Map of agentName → in-flight start promise (prevents duplicate starts from concurrent requests) */
  private readonly startingAgents = new Map<
    string,
    Promise<{ success: boolean; name: string; port: number; error?: string }>
  >();
  /** Map of agentName → error state (set when an agent fails to start or crashes) */
  private readonly agentErrors = new Map<string, AgentError>();

  constructor(private readonly options: WebUIOptions) {}

  /** Build a RouteContext that handlers use to access shared state */
  private get ctx(): RouteContext {
    return {
      options: this.options,
      runningAgents: this.runningAgents,
      startingAgents: this.startingAgents,
      agentErrors: this.agentErrors,
      setCorsHeaders: (res, origin) => this.setCorsHeaders(res, origin),
      readBody: req => this.readBody(req),
    };
  }

  start(): void {
    const { uiPort, onReady, onLog } = this.options;
    const webUiBaseUrl = `http://localhost:${uiPort}`;

    this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
      void (async () => {
        // DNS rebinding protection — reject requests where the Host header
        // is not localhost/127.0.0.1. An attacker could use a custom domain
        // that resolves to 127.0.0.1, which would bypass origin checks since
        // the browser considers it a different origin.
        const host = (req.headers.host ?? '').replace(/:\d+$/, '');
        if (host !== 'localhost' && host !== '127.0.0.1') {
          onLog?.('warn', `Blocked request with unexpected Host: ${req.headers.host}`);
          res.writeHead(403, { 'Content-Type': 'text/plain' });
          res.end('Forbidden');
          return;
        }

        const origin = req.headers.origin;

        // Server-side origin validation — reject cross-origin requests from
        // origins not in the allowlist before any handler logic executes.
        // This is critical because CORS headers alone only prevent the browser
        // from reading responses; the server still processes the request and
        // executes side effects (starting agents, invoking with AWS credentials).
        if (origin && !this.allowedOrigins.includes(origin)) {
          onLog?.('warn', `Blocked cross-origin request from ${origin}`);
          res.writeHead(403, { 'Content-Type': 'text/plain' });
          res.end('Forbidden');
          return;
        }

        // Handle CORS preflight
        if (req.method === 'OPTIONS') {
          this.setCorsHeaders(res, origin);
          res.writeHead(204);
          res.end();
          return;
        }

        // Require a custom header on all POST requests. This forces browsers
        // to send a CORS preflight (which our origin check blocks for cross-
        // origin callers), closing the gap where simple form POSTs bypass
        // preflight and may omit the Origin header entirely.
        if (req.method === 'POST' && !req.headers['x-agentcore-local']) {
          res.writeHead(403, { 'Content-Type': 'text/plain' });
          res.end('Forbidden: missing X-Agentcore-Local header');
          return;
        }

        try {
          await this.route(req, res, origin);
        } catch (err) {
          onLog?.('error', `Request error: ${err instanceof Error ? err.message : String(err)}`);
          if (!res.headersSent) {
            this.setCorsHeaders(res, origin);
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Internal Server Error');
          }
        }
      })();
    });

    this.server.listen(uiPort, '127.0.0.1', () => {
      onReady?.(webUiBaseUrl);
    });

    this.server.on('error', (err: Error) => {
      onLog?.('error', `Web UI server error: ${err.message}`);
    });

    this.startConfigWatcher();
  }

  stop(): void {
    this.configWatcher?.close();
    this.configWatcher = null;
    for (const { server } of this.runningAgents.values()) {
      server.kill();
    }
    this.runningAgents.clear();
    this.server?.close();
    this.server = null;
  }

  /**
   * Watch agentcore.json for changes and reload the agents list.
   * Only active when both configRoot and reloadAgents are provided.
   */
  private startConfigWatcher(): void {
    const { configRoot, reloadAgents, onLog } = this.options;
    if (!configRoot || !reloadAgents) return;

    const configPath = path.join(configRoot, 'agentcore.json');
    try {
      this.configWatcher = fs.watch(configPath, () => {
        void reloadAgents().then(
          agents => {
            this.options.agents = agents;
            onLog?.('info', `Reloaded agents from agentcore.json (${agents.length} agent(s))`);
          },
          err => {
            onLog?.('warn', `Failed to reload agentcore.json: ${err instanceof Error ? err.message : String(err)}`);
          }
        );
      });
    } catch (err) {
      onLog?.('warn', `Could not watch agentcore.json: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Route an incoming request to the appropriate handler */
  private async route(req: IncomingMessage, res: ServerResponse, origin?: string): Promise<void> {
    const ctx = this.ctx;

    if (req.method === 'GET' && req.url === '/api/status') {
      handleStatus(ctx, res, origin);
    } else if (req.method === 'GET' && req.url === '/api/resources') {
      await handleResources(ctx, res, origin);
    } else if (req.method === 'GET' && req.url?.startsWith('/api/traces/')) {
      await handleGetTrace(ctx, req, res, origin);
    } else if (req.method === 'GET' && req.url?.startsWith('/api/traces')) {
      await handleListTraces(ctx, req, res, origin);
    } else if (req.method === 'POST' && req.url === '/api/start') {
      await handleStart(ctx, req, res, origin);
    } else if (req.method === 'POST' && req.url === '/invocations') {
      await handleInvocations(ctx, req, res, origin);
    } else if (req.method === 'POST' && req.url === '/api/mcp') {
      await handleMcpProxy(ctx, req, res, origin);
    } else if (req.method === 'GET' && req.url?.startsWith('/api/a2a/agent-card')) {
      await handleA2AAgentCard(ctx, req, res, origin);
    } else if (req.method === 'GET' && req.url?.startsWith('/api/memory')) {
      await handleListMemoryRecords(ctx, req, res, origin);
    } else if (req.method === 'POST' && req.url === '/api/memory/search') {
      await handleRetrieveMemoryRecords(ctx, req, res, origin);
    } else if (req.method === 'GET' && this.serveStaticFile(req, res)) {
      // Served a static frontend file
    } else {
      this.setCorsHeaders(res, origin);
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
  }

  /** Serve a static file from the frontend dist directory. Returns true if served. */
  private serveStaticFile(req: IncomingMessage, res: ServerResponse): boolean {
    const distDir = resolveUIDistDir();
    if (!distDir) return false;

    const urlPath = req.url?.split('?')[0] ?? '/';
    const ext = path.extname(urlPath);

    // Serve the exact file if it has a known extension and exists
    if (ext && MIME_TYPES[ext]) {
      const filePath = path.join(distDir, urlPath);
      if (!filePath.startsWith(distDir)) return false;
      if (fs.existsSync(filePath)) {
        const headers: Record<string, string> = { 'Content-Type': MIME_TYPES[ext] };
        if (ext === '.html') headers['Content-Security-Policy'] = CSP_HEADER;
        res.writeHead(200, headers);
        fs.createReadStream(filePath).pipe(res);
        return true;
      }
    }

    // SPA fallback: serve index.html for all other paths
    const indexPath = path.join(distDir, 'index.html');
    if (fs.existsSync(indexPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': CSP_HEADER });
      fs.createReadStream(indexPath).pipe(res);
      return true;
    }

    return false;
  }

  /** Origins that are allowed to make cross-origin requests to this server. */
  private get allowedOrigins(): string[] {
    const { uiPort } = this.options;
    return [
      `http://localhost:${uiPort}`,
      WEB_UI_LOCAL_URL, // Vite dev server for frontend HMR workflow
    ];
  }

  private setCorsHeaders(res: ServerResponse, origin?: string): void {
    const fallback = this.allowedOrigins[0] ?? WEB_UI_LOCAL_URL;
    const allowedOrigin = origin && this.allowedOrigins.includes(origin) ? origin : fallback;
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Agentcore-Local, Mcp-Session-Id');
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, x-session-id');
    res.setHeader('Vary', 'Origin');
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks).toString()));
      req.on('error', reject);
    });
  }
}
