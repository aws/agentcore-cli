import type { Result } from '../../../lib/result';

export interface ExecOptions {
  /** Target runtime ARN (from --runtime). Skips agent picker when provided. */
  runtimeArn?: string;
  /** Routes the connection to a specific VM (from --session-id). */
  sessionId?: string;
  /** Reconnect to an existing shell (from --shell-id). Maps to `shellId` query param at the wire boundary. */
  shellId?: string;
  /** Interactive PTY session (from --it flag). */
  interactive?: boolean;
  /** Positional args — the bash command for one-shot mode. */
  command?: string[];
  region?: string;
  /** Bearer token for CUSTOM_JWT auth (from --bearer-token). When set, skips SigV4 and authenticates via WebSocket subprotocol. */
  bearerToken?: string;
  /** Deployment target name (from --target). Selects which target from agentcore.json to use. */
  targetName?: string;
  /** W3C baggage header value to forward with the WebSocket upgrade. */
  baggage?: string;
  /** Timeout in seconds for one-shot commands (from --timeout). */
  timeout?: number;
  /** Output result as JSON object to stdout (one-shot mode only). */
  json?: boolean;
}

export type ExecResult = Result & {
  /** Runtime session ID — include in reconnect hint. */
  sessionId?: string;
  /** Shell ID — include in reconnect hint. */
  shellId?: string;
  /** Exit code of the shell process (null = server closed without STATUS frame). */
  exitCode?: number | null;
  /** Number of reconnect attempts made during the session. */
  reconnectAttempts?: number;
  /** True if the session was kicked by another client (close code 4000). */
  wasKicked?: boolean;
  /** True if the initial connection reattached an existing shell. */
  isReconnect?: boolean;
  /** True if the user explicitly detached with Ctrl+] (shell is still alive on the VM). */
  detached?: boolean;
  /** Buffered stdout from a one-shot command (populated when --json is set). */
  stdout?: string;
  /** Buffered stderr from a one-shot command (populated when --json is set). */
  stderr?: string;
};
