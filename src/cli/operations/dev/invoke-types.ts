/** Error thrown when the dev server returns a non-OK HTTP response. */
export class ServerError extends Error {
  constructor(
    public readonly statusCode: number,
    body: string
  ) {
    super(body || `Server returned ${statusCode}`);
    this.name = 'ServerError';
  }
}

/** Error thrown when the connection to the dev server fails. */
export class ConnectionError extends Error {
  constructor(cause: Error) {
    super(cause.message);
    this.name = 'ConnectionError';
  }
}

/** Logger interface for SSE events and error logging */
export interface SSELogger {
  logSSEEvent(rawLine: string): void;
  /** Optional method to log errors and debug info */
  log?(level: 'error' | 'warn' | 'system', message: string): void;
}

export interface InvokeStreamingOptions {
  port: number;
  message: string;
  /** Optional logger for SSE event debugging */
  logger?: SSELogger;
  /** Callback for A2A task status updates (e.g. 'working', 'input-required') */
  onStatus?: (status: string) => void;
  /** Custom headers to forward to the agent */
  headers?: Record<string, string>;
}
