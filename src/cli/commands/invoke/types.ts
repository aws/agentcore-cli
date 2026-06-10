import type { Result } from '../../../lib/result';

export interface InvokeOptions {
  agentName?: string;
  harnessName?: string;
  /** Direct harness ARN — bypasses project config and deployed state resolution */
  harnessArn?: string;
  /** AWS region (used with --harness-arn) */
  region?: string;
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
  /** Print verbose streaming JSON events instead of formatted text (harness only) */
  verbose?: boolean;
  /** Override model ID for this invocation (harness only) */
  modelId?: string;
  /** Override model provider for this invocation (harness only): bedrock, open_ai, gemini */
  modelProvider?: string;
  /** Override API key ARN for this invocation (harness only, open_ai/gemini) */
  apiKeyArn?: string;
  /** Override tools for this invocation (harness only, comma-separated) */
  tools?: string;
  /** Override max iterations (harness only) */
  maxIterations?: number;
  /** Override timeout seconds (harness only) */
  harnessTimeout?: number;
  /** Override max tokens (harness only) */
  maxTokens?: number;
  /** Skills to use (harness only, comma-separated paths) */
  skills?: string;
  /** Override system prompt (harness only) */
  systemPrompt?: string;
  /** Override allowed tools (harness only, comma-separated) */
  allowedTools?: string;
  /** Override memory actor ID (harness only) */
  actorId?: string;
  /** Payment instrument ID for x402 payments */
  paymentInstrumentId?: string;
  /** Payment session ID for budget tracking */
  paymentSessionId?: string;
  /** Auto-create/reuse a payment session for testing (runs with developer ManagementRole credentials) */
  autoSession?: boolean;
  /**
   * Payments end-user identity (wallet owner). Written into the invoke body as
   * `user_id` so the agent scopes the payment instrument/session/budget to it.
   * Falls back to `userId` when omitted. Distinct from `userId`, which is the
   * runtime/Identity header and is not used for payment scoping.
   */
  paymentUserId?: string;
}

export type InvokeResult = Result & {
  logFilePath?: string;
  agentName?: string;
  targetName?: string;
  response?: string;
  sessionId?: string;
  exitCode?: number;
};
