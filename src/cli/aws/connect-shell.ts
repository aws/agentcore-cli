import { ShellKickedError } from '../../lib/errors/types';
import { getCredentialProvider } from './account';
import { dataPlaneEndpoint } from './stage-endpoint';
import { Sha256 } from '@aws-crypto/sha256-js';
import { HttpRequest } from '@smithy/protocol-http';
import { SignatureV4 } from '@smithy/signature-v4';
import WebSocket from 'ws';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ShellReconnectOptions {
  /** Maximum number of reconnect attempts. 0 = unlimited. Default: 5 */
  maxRetries?: number;
  /** Initial delay in seconds between retries. Doubles each attempt. Default: 1 */
  baseDelay?: number;
  /** Maximum delay in seconds between retries. Default: 15 */
  maxDelay?: number;
  /** Called at the start of each reconnect attempt. */
  onAttempt?: (attempt: number, reason: string) => void;
  /** Called when close code 4000 is received — another client took the session. */
  onKicked?: () => void;
}

export interface ConnectShellOptions {
  region: string;
  runtimeArn: string;
  /** Routes the WebSocket to a specific VM */
  sessionId?: string;
  /** Reconnect to an existing shell. Maps to `shellId` query param at the wire boundary. */
  shellId?: string;
  /** Extra headers merged into the signed upgrade request */
  headers?: Record<string, string>;
  /** When provided, retries the initial WebSocket handshake on failure */
  reconnect?: ShellReconnectOptions;
  /** Bearer token for CUSTOM_JWT auth. When set, authenticates via WebSocket subprotocol instead of SigV4. */
  bearerToken?: string;
}

export interface ShellConnection {
  ws: WebSocket;
  /** The server-assigned shell identifier (from the 101 upgrade response header). */
  shellId: string;
  sessionId?: string;
}

// ---------------------------------------------------------------------------
// URL builder
// ---------------------------------------------------------------------------

/** Build the wss:// URL for the shell endpoint.
 *  Respects AGENTCORE_STAGE=beta|gamma for pre-release environments.
 */
export function buildShellUrl(region: string, runtimeArn: string, shellId?: string): URL {
  // dataPlaneEndpoint returns https://...; strip scheme to get the bare hostname for wss://
  const host = dataPlaneEndpoint(region).replace(/^https?:\/\//, '');
  const encoded = encodeURIComponent(runtimeArn);
  const url = new URL(`wss://${host}/runtimes/${encoded}/ws/shells`);
  url.searchParams.set('qualifier', 'DEFAULT');
  if (shellId) {
    url.searchParams.set('shellId', shellId);
  }
  return url;
}

// ---------------------------------------------------------------------------
// SigV4 signing for WebSocket upgrade
// ---------------------------------------------------------------------------

async function signUpgradeHeaders(
  region: string,
  url: URL,
  extra: Record<string, string> = {}
): Promise<Record<string, string>> {
  // Sign an HTTP GET (WebSocket upgrade) with SigV4
  const query: Record<string, string> = {};
  url.searchParams.forEach((v, k) => {
    query[k] = v;
  });

  const request = new HttpRequest({
    method: 'GET',
    protocol: 'https:',
    hostname: url.hostname,
    path: url.pathname,
    query,
    headers: {
      host: url.hostname,
      ...extra,
    },
  });

  const signer = new SignatureV4({
    service: 'bedrock-agentcore',
    region,
    credentials: getCredentialProvider(),
    sha256: Sha256,
  });

  const signed = await signer.sign(request);
  return signed.headers as Record<string, string>;
}

// ---------------------------------------------------------------------------
// HTTP upgrade error translation
// ---------------------------------------------------------------------------

/** Translate WebSocket upgrade HTTP errors into user-friendly messages. */
function translateUpgradeError(err: Error): Error {
  const msg = err.message ?? '';
  if (msg.includes('424') || msg.includes('Failed Dependency')) {
    return new Error('Agent VM is not ready (error 424). Run `agentcore status` to check deployment.');
  }
  if (msg.includes('429') || msg.includes('Too Many')) {
    return new Error('Maximum terminal sessions reached (10). Close an existing session and retry.');
  }
  if (msg.includes('403') || msg.includes('Forbidden')) {
    return new Error(
      'Access denied (403). Check IAM permission bedrock-agentcore:InvokeAgentRuntimeCommandWithWebSocketStream.'
    );
  }
  return err;
}

// ---------------------------------------------------------------------------
// Core connector
// ---------------------------------------------------------------------------

async function openWebSocket(options: ConnectShellOptions): Promise<ShellConnection> {
  const { region, runtimeArn, shellId, sessionId, bearerToken } = options;
  const url = buildShellUrl(region, runtimeArn, shellId);

  let ws: WebSocket;
  if (bearerToken) {
    // CUSTOM_JWT: bearer token embedded via base64UrlBearerAuthorization subprotocol scheme.
    // The token is base64url-encoded (no padding) and sent as:
    //   Sec-WebSocket-Protocol: base64UrlBearerAuthorization.<encoded>, base64UrlBearerAuthorization
    // SigV4 signing is skipped entirely.
    const encoded = Buffer.from(bearerToken).toString('base64url');
    const extraHeaders: Record<string, string> = { ...(options.headers ?? {}) };
    if (sessionId) {
      extraHeaders['X-Amzn-Bedrock-AgentCore-Runtime-Session-Id'] = sessionId;
    }
    ws = new WebSocket(url.toString(), [`base64UrlBearerAuthorization.${encoded}`, 'base64UrlBearerAuthorization'], {
      headers: extraHeaders,
    });
  } else {
    // Default: SigV4-signed upgrade headers
    const extraHeaders: Record<string, string> = { ...(options.headers ?? {}) };
    if (sessionId) {
      extraHeaders['X-Amzn-Bedrock-AgentCore-Runtime-Session-Id'] = sessionId;
    }
    const signedHeaders = await signUpgradeHeaders(region, url, extraHeaders);
    ws = new WebSocket(url.toString(), { headers: signedHeaders });
  }

  return new Promise<ShellConnection>((resolve, reject) => {
    let settled = false;
    // Shell ID from the 101 response header — the primary (and now only) source.
    let shellIdFromHeader: string | undefined;

    const fail = (err: Error) => {
      if (!settled) {
        settled = true;
        ws.terminate();
        reject(translateUpgradeError(err));
      }
    };

    // Read shellId from the 101 Switching Protocols response headers.
    ws.on('upgrade', (response: { headers: Record<string, string | string[] | undefined> }) => {
      const raw = response.headers['x-amzn-bedrock-agentcore-shell-id'];
      if (raw) {
        shellIdFromHeader = Array.isArray(raw) ? raw[0] : raw;
      }
    });

    ws.on('error', fail);

    ws.on('close', (code: number) => {
      if (!settled) {
        if (code === 4000) {
          fail(new ShellKickedError());
        } else {
          fail(new Error(`WebSocket closed before open (code ${code})`));
        }
      }
    });

    // Connection is ready immediately after WebSocket opens — no confirmation frame wait.
    ws.on('open', () => {
      if (settled) return;
      // The 101 upgrade header is the only server-provided source of the shell ID now that the
      // 0x03 confirmation frame is gone; on a reconnect the caller-supplied shellId is a valid
      // fallback. If neither is present we have no usable ID — fail instead of resolving with '',
      // because an empty shell ID silently breaks reconnect (the session cannot be reattached and
      // the reconnect hint is suppressed). The server returns this header on every successful
      // upgrade, so its absence is a real anomaly, not a normal state.
      const resolvedShellId = shellIdFromHeader ?? shellId;
      if (!resolvedShellId) {
        fail(
          new Error(
            'Shell session could not be established: the server did not return a shell ID. ' +
              'Retry, or run `agentcore status` to check the runtime.'
          )
        );
        return;
      }
      settled = true;
      resolve({
        ws,
        shellId: resolvedShellId,
        sessionId: options.sessionId,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// RFC 6455 keepalive
// ---------------------------------------------------------------------------

const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 60_000;

/**
 * Start sending RFC 6455 Ping frames every 30s.
 * If no Pong arrives within 60s, calls `onDead()` so the caller can reconnect.
 * Returns a stop function that cleans up timers and listeners.
 */
export function startKeepalive(ws: WebSocket, onDead: () => void): () => void {
  let pongTimer: ReturnType<typeof setTimeout> | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  const stop = () => {
    stopped = true;
    if (pingTimer !== null) clearInterval(pingTimer);
    if (pongTimer !== null) clearTimeout(pongTimer);
    ws.removeAllListeners('pong');
  };

  ws.on('pong', () => {
    if (pongTimer !== null) clearTimeout(pongTimer);
    pongTimer = null;
  });

  pingTimer = setInterval(() => {
    if (stopped || ws.readyState !== ws.OPEN) return;
    ws.ping();
    pongTimer = setTimeout(() => {
      if (!stopped) onDead();
    }, PONG_TIMEOUT_MS);
  }, PING_INTERVAL_MS);

  return stop;
}

// ---------------------------------------------------------------------------
// Reconnect loop
// ---------------------------------------------------------------------------

/** Jitter a delay by ±25% */
function jitter(ms: number): number {
  return ms * (0.75 + Math.random() * 0.5);
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Open a shell WebSocket, retrying the initial handshake on failure.
 * Once the connection is established this function returns — mid-session reconnect
 * is not handled here; that is the caller's responsibility.
 * Throws `ShellKickedError` when the server sends close code 4000 — callers must not retry.
 */
export async function connectShell(options: ConnectShellOptions): Promise<ShellConnection> {
  if (!options.reconnect) {
    return openWebSocket(options);
  }

  const { maxRetries = 5, baseDelay = 1, maxDelay = 15, onAttempt, onKicked } = options.reconnect;
  const OUTER_DELAY_MS = 30_000;
  const TOTAL_WINDOW_MS = 15 * 60 * 1000; // ~15 min

  const start = Date.now();
  let attempt = 0;
  let currentShellId = options.shellId;
  let lastDisconnectReason = 'network drop';

  while (true) {
    try {
      const conn = await openWebSocket({ ...options, shellId: currentShellId });

      // Carry shellId forward so subsequent reconnects reattach to the same PTY
      currentShellId = conn.shellId;
      return conn;
    } catch (err) {
      if (err instanceof ShellKickedError) {
        onKicked?.();
        throw err; // MUST NOT retry
      }

      attempt++;
      lastDisconnectReason = err instanceof Error ? err.message : String(err);
      onAttempt?.(attempt, lastDisconnectReason);

      // Don't sleep on the last attempt — throw immediately so the caller gets the error
      // without the inner backoff + OUTER_DELAY_MS adding ~45s of silence after (N/N).
      if (maxRetries > 0 && attempt >= maxRetries) throw err;
      if (Date.now() - start > TOTAL_WINDOW_MS) throw err;

      // Inner exponential backoff: 1s → 2s → 4s → 8s → 15s (capped), ±25% jitter
      const innerDelay = Math.min(baseDelay * Math.pow(2, Math.min(attempt - 1, 4)), maxDelay);
      await sleep(jitter(innerDelay * 1000));

      // After 5 inner attempts, add outer 30s pause before resuming
      if (attempt % 5 === 0) {
        await sleep(OUTER_DELAY_MS);
      }
    }
  }
}
