export interface InvokeOptions {
  agentName?: string;
  targetName?: string;
  prompt?: string;
  sessionId?: string;
  userId?: string;
  json?: boolean;
  stream?: boolean;
  /** MCP tool name (used with prompt "call-tool") */
  tool?: string;
  /** MCP tool arguments as JSON string (used with --tool) */
  input?: string;
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
  error?: string;
  logFilePath?: string;
  /** Model provider (e.g., "Anthropic", "Bedrock") */
  providerInfo?: string;
}
