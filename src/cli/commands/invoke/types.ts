export interface InvokeOptions {
  agentName?: string;
  targetName?: string;
  prompt?: string;
  /** Path to a file containing the prompt (alternative to --prompt / positional) */
  promptFile?: string;
  sessionId?: string;
  userId?: string;
  json?: boolean;
  stream?: boolean;
  /** MCP tool name (used with prompt "call-tool") */
  tool?: string;
  /** MCP tool arguments as JSON string (used with --tool) */
  input?: string;
  /** Execute a shell command in the runtime container instead of invoking the agent */
  exec?: boolean;
  /** Timeout in seconds for exec commands */
  timeout?: number;
  /** Custom headers to forward to the agent runtime (key-value pairs) */
  headers?: Record<string, string>;
  /** Bearer token for CUSTOM_JWT auth (bypasses SigV4) */
  bearerToken?: string;
}

export interface InvokeResult {
  success: boolean;
  agentName?: string;
  targetName?: string;
  response?: string;
  sessionId?: string;
  error?: string;
  logFilePath?: string;
}
