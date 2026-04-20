import { parseJsonRpcResponse } from '../../lib/utils/json-rpc';
import { getCredentialProvider } from './account';
import {
  BedrockAgentCoreClient,
  EvaluateCommand,
  type EvaluationReferenceInput,
  InvokeAgentRuntimeCommand,
  InvokeAgentRuntimeCommandCommand,
  StopRuntimeSessionCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import type { HttpRequest } from '@smithy/protocol-http';
import type { DocumentType } from '@smithy/types';

/**
 * Create a BedrockAgentCoreClient with optional custom header injection middleware.
 */
function createAgentCoreClient(region: string, headers?: Record<string, string>): BedrockAgentCoreClient {
  const client = new BedrockAgentCoreClient({
    region,
    credentials: getCredentialProvider(),
  });

  if (headers && Object.keys(headers).length > 0) {
    client.middlewareStack.add(
      next => async args => {
        const request = args.request as HttpRequest;
        for (const [name, value] of Object.entries(headers)) {
          request.headers[name] = value;
        }
        return next(args);
      },
      { step: 'build', name: 'addCustomHeaders' }
    );
  }

  return client;
}

/** Logger interface for SSE events */
export interface SSELogger {
  logSSEEvent(rawLine: string): void;
}

/** Default user ID sent with invocations. Container agents require this to obtain workload access tokens. */
export const DEFAULT_RUNTIME_USER_ID = 'default-user';

export interface InvokeAgentRuntimeOptions {
  region: string;
  runtimeArn: string;
  payload: string;
  sessionId?: string;
  /** User ID for the runtime invocation. Defaults to 'default-user'. Required for Container agents using identity providers. */
  userId?: string;
  /** Optional logger for SSE event debugging */
  logger?: SSELogger;
  /** Custom headers to forward to the agent runtime */
  headers?: Record<string, string>;
  /** Bearer token for CUSTOM_JWT auth. When provided, uses raw HTTP with Authorization header instead of SigV4. */
  bearerToken?: string;
}

export interface InvokeAgentRuntimeResult {
  content: string;
  sessionId?: string;
}

export interface StreamingInvokeResult {
  stream: AsyncGenerator<string, void, unknown>;
  sessionId: string | undefined;
}

export interface StopRuntimeSessionOptions {
  region: string;
  runtimeArn: string;
  sessionId: string;
}

export interface StopRuntimeSessionResult {
  sessionId: string | undefined;
  statusCode: number | undefined;
}

/**
 * Parse a single SSE data line and extract the content.
 * Returns null if the line is not a data line or contains an error.
 */
export function parseSSELine(line: string): { content: string | null; error: string | null } {
  if (!line.startsWith('data: ')) {
    return { content: null, error: null };
  }
  const content = line.slice(6);
  try {
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed === 'string') {
      return { content: parsed, error: null };
    } else if (parsed && typeof parsed === 'object' && 'error' in parsed) {
      return { content: null, error: String((parsed as { error: unknown }).error) };
    }
  } catch {
    return { content, error: null };
  }
  return { content: null, error: null };
}

/**
 * Parse SSE response into combined text.
 */
export function parseSSE(text: string): string {
  const parts: string[] = [];
  for (const line of text.split('\n')) {
    const { content, error } = parseSSELine(line);
    if (error) {
      return `Error: ${error}`;
    }
    if (content) {
      parts.push(content);
    }
  }
  return parts.join('');
}

/**
 * Extract result from a JSON response object.
 * Handles both {"result": "..."} and plain text responses.
 */
export function extractResult(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && 'result' in parsed) {
      const result = (parsed as { result: unknown }).result;
      return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    }
    return typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2);
  } catch {
    return text;
  }
}

// ---------------------------------------------------------------------------
// Bearer token (CUSTOM_JWT) thin HTTP client
// ---------------------------------------------------------------------------

/**
 * Build the invoke URL for a runtime ARN.
 * Format: https://bedrock-agentcore.{REGION}.amazonaws.com/runtimes/{ESCAPED_ARN}/invocations?qualifier=DEFAULT
 */
function buildInvokeUrl(region: string, runtimeArn: string): string {
  const escapedArn = encodeURIComponent(runtimeArn);
  return `https://bedrock-agentcore.${region}.amazonaws.com/runtimes/${escapedArn}/invocations?qualifier=DEFAULT`;
}

/**
 * Invoke an AgentCore Runtime using bearer token auth (raw HTTP, no SigV4).
 * Used when the runtime has CUSTOM_JWT authorizer configured.
 */
async function invokeWithBearerTokenStreaming(options: InvokeAgentRuntimeOptions): Promise<StreamingInvokeResult> {
  const url = buildInvokeUrl(options.region, options.runtimeArn);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${options.bearerToken}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (options.sessionId) {
    headers['X-Amzn-Bedrock-AgentCore-Runtime-Session-Id'] = options.sessionId;
  }
  headers['X-Amzn-Bedrock-AgentCore-Runtime-User-Id'] = options.userId ?? DEFAULT_RUNTIME_USER_ID;

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ prompt: options.payload }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Invoke failed (${res.status}): ${body || res.statusText}`);
  }

  const sessionId = res.headers.get('X-Amzn-Bedrock-AgentCore-Runtime-Session-Id') ?? undefined;
  const bodyReader = res.body?.getReader();
  if (!bodyReader) {
    throw new Error('No response body from AgentCore Runtime');
  }

  // Assign to const after null check so TypeScript narrows the type inside the generator
  const reader = bodyReader;
  const decoder = new TextDecoder();
  const { logger } = options;

  async function* streamGenerator(): AsyncGenerator<string, void, unknown> {
    let buffer = '';
    let fullResponse = '';
    let yieldedContent = false;

    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;

        const decoded = decoder.decode(result.value as Uint8Array | undefined, { stream: true });
        buffer += decoded;
        fullResponse += decoded;

        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (logger && line.trim()) {
            logger.logSSEEvent(line);
          }
          const { content, error } = parseSSELine(line);
          if (error) {
            yield `Error: ${error}`;
            return;
          }
          if (content) {
            yield content;
            yieldedContent = true;
          }
        }
      }

      if (buffer) {
        if (logger && buffer.trim()) {
          logger.logSSEEvent(buffer);
        }
        const { content, error } = parseSSELine(buffer);
        if (error) {
          yield `Error: ${error}`;
        } else if (content) {
          yield content;
          yieldedContent = true;
        }
      }

      if (!yieldedContent && fullResponse.trim()) {
        yield extractResult(fullResponse.trim());
      }
    } finally {
      reader.releaseLock();
    }
  }

  return { stream: streamGenerator(), sessionId };
}

/**
 * Invoke an AgentCore Runtime using bearer token auth (non-streaming).
 */
async function invokeWithBearerToken(options: InvokeAgentRuntimeOptions): Promise<InvokeAgentRuntimeResult> {
  const url = buildInvokeUrl(options.region, options.runtimeArn);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${options.bearerToken}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (options.sessionId) {
    headers['X-Amzn-Bedrock-AgentCore-Runtime-Session-Id'] = options.sessionId;
  }
  headers['X-Amzn-Bedrock-AgentCore-Runtime-User-Id'] = options.userId ?? DEFAULT_RUNTIME_USER_ID;

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ prompt: options.payload }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Invoke failed (${res.status}): ${body || res.statusText}`);
  }

  const sessionId = res.headers.get('X-Amzn-Bedrock-AgentCore-Runtime-Session-Id') ?? undefined;
  const text = await res.text();
  const content = text.includes('data: ') ? parseSSE(text) : extractResult(text);

  return { content, sessionId };
}

// ---------------------------------------------------------------------------
// SDK-based invoke (SigV4)
// ---------------------------------------------------------------------------

/**
 * Invoke an AgentCore Runtime and stream the response chunks.
 * Returns an object with the stream generator and session ID.
 */
export async function invokeAgentRuntimeStreaming(options: InvokeAgentRuntimeOptions): Promise<StreamingInvokeResult> {
  if (options.bearerToken) {
    return invokeWithBearerTokenStreaming(options);
  }

  const client = createAgentCoreClient(options.region, options.headers);

  const command = new InvokeAgentRuntimeCommand({
    agentRuntimeArn: options.runtimeArn,
    payload: new TextEncoder().encode(JSON.stringify({ prompt: options.payload })),
    contentType: 'application/json',
    accept: 'application/json',
    runtimeSessionId: options.sessionId,
    runtimeUserId: options.userId ?? DEFAULT_RUNTIME_USER_ID,
  });

  const response = await client.send(command);
  const sessionId = response.runtimeSessionId;

  if (!response.response) {
    throw new Error('No response from AgentCore Runtime');
  }

  const webStream = response.response.transformToWebStream();
  const reader = webStream.getReader();
  const decoder = new TextDecoder();

  async function* streamGenerator(): AsyncGenerator<string, void, unknown> {
    let buffer = '';
    let fullResponse = '';
    let yieldedContent = false;
    const { logger } = options;

    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;

        const decoded = decoder.decode(result.value as Uint8Array, { stream: true });
        buffer += decoded;
        fullResponse += decoded;

        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          // Log raw SSE line if logger provided
          if (logger && line.trim()) {
            logger.logSSEEvent(line);
          }
          const { content, error } = parseSSELine(line);
          if (error) {
            yield `Error: ${error}`;
            return;
          }
          if (content) {
            yield content;
            yieldedContent = true;
          }
        }
      }

      // Process any remaining content in the buffer
      if (buffer) {
        // Log raw SSE line if logger provided
        if (logger && buffer.trim()) {
          logger.logSSEEvent(buffer);
        }
        const { content, error } = parseSSELine(buffer);
        if (error) {
          yield `Error: ${error}`;
        } else if (content) {
          yield content;
          yieldedContent = true;
        }
      }

      // Fallback for plain JSON responses (non-SSE)
      if (!yieldedContent && fullResponse.trim()) {
        yield extractResult(fullResponse.trim());
      }
    } finally {
      reader.releaseLock();
    }
  }

  return {
    stream: streamGenerator(),
    sessionId,
  };
}

/**
 * Invoke an AgentCore Runtime and return the response.
 */
export async function invokeAgentRuntime(options: InvokeAgentRuntimeOptions): Promise<InvokeAgentRuntimeResult> {
  if (options.bearerToken) {
    return invokeWithBearerToken(options);
  }

  const client = createAgentCoreClient(options.region, options.headers);

  const command = new InvokeAgentRuntimeCommand({
    agentRuntimeArn: options.runtimeArn,
    payload: new TextEncoder().encode(JSON.stringify({ prompt: options.payload })),
    contentType: 'application/json',
    accept: 'application/json',
    runtimeSessionId: options.sessionId,
    runtimeUserId: options.userId ?? DEFAULT_RUNTIME_USER_ID,
  });

  const response = await client.send(command);

  if (!response.response) {
    throw new Error('No response from AgentCore Runtime');
  }

  const bytes = await response.response.transformToByteArray();
  const text = new TextDecoder().decode(bytes);

  // Parse SSE format if present
  const content = text.includes('data: ') ? parseSSE(text) : extractResult(text);

  return {
    content,
    sessionId: response.runtimeSessionId,
  };
}

// ============================================================================
// Evaluate
// ============================================================================

export interface EvaluateOptions {
  region: string;
  evaluatorId: string;
  sessionSpans: DocumentType[];
  targetSpanIds?: string[];
  targetTraceIds?: string[];
  evaluationReferenceInputs?: EvaluationReferenceInput[];
}

export interface EvaluationResultContext {
  sessionId: string | undefined;
  traceId: string | undefined;
  spanId: string | undefined;
}

export interface EvaluationResultTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface EvaluationResult {
  evaluatorArn: string | undefined;
  evaluatorId: string | undefined;
  evaluatorName: string | undefined;
  explanation: string | undefined;
  value: number | undefined;
  label: string | undefined;
  errorMessage: string | undefined;
  errorCode: string | undefined;
  context: EvaluationResultContext | undefined;
  tokenUsage: EvaluationResultTokenUsage | undefined;
}

export interface EvaluateResult {
  evaluationResults: EvaluationResult[];
}

/**
 * Run on-demand evaluation of agent traces using a specified evaluator.
 */
export async function evaluate(options: EvaluateOptions): Promise<EvaluateResult> {
  const client = new BedrockAgentCoreClient({
    region: options.region,
    credentials: getCredentialProvider(),
  });

  const evaluationTarget = options.targetSpanIds
    ? { spanIds: options.targetSpanIds }
    : options.targetTraceIds
      ? { traceIds: options.targetTraceIds }
      : undefined;

  const command = new EvaluateCommand({
    evaluatorId: options.evaluatorId,
    evaluationInput: {
      sessionSpans: options.sessionSpans,
    },
    ...(evaluationTarget ? { evaluationTarget } : {}),
    ...(options.evaluationReferenceInputs ? { evaluationReferenceInputs: options.evaluationReferenceInputs } : {}),
  });

  const response = await client.send(command);

  if (!response.evaluationResults) {
    throw new Error('No evaluation results returned');
  }

  return {
    evaluationResults: response.evaluationResults.map(r => {
      const spanContext = r.context && 'spanContext' in r.context ? r.context.spanContext : undefined;

      return {
        evaluatorArn: r.evaluatorArn,
        evaluatorId: r.evaluatorId,
        evaluatorName: r.evaluatorName,
        explanation: r.explanation,
        value: r.value,
        label: r.label,
        errorMessage: r.errorMessage,
        errorCode: r.errorCode,
        context: spanContext
          ? {
              sessionId: spanContext.sessionId,
              traceId: spanContext.traceId,
              spanId: spanContext.spanId,
            }
          : undefined,
        tokenUsage: r.tokenUsage
          ? {
              inputTokens: r.tokenUsage.inputTokens ?? 0,
              outputTokens: r.tokenUsage.outputTokens ?? 0,
              totalTokens: r.tokenUsage.totalTokens ?? 0,
            }
          : undefined,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// MCP: JSON-RPC over InvokeAgentRuntime
// ---------------------------------------------------------------------------

export interface McpInvokeOptions {
  region: string;
  runtimeArn: string;
  userId?: string;
  mcpSessionId?: string;
  logger?: SSELogger;
  /** Custom headers to forward to the agent runtime */
  headers?: Record<string, string>;
  /** Bearer token for CUSTOM_JWT auth. When provided, uses raw HTTP with Authorization header instead of SigV4. */
  bearerToken?: string;
}

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpListToolsResult {
  tools: McpToolDef[];
  mcpSessionId?: string;
}

let mcpRequestId = 1;

interface McpRpcResult {
  result: Record<string, unknown>;
  mcpSessionId?: string;
  error?: { message?: string; code?: number };
}

const TRANSIENT_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const MAX_FETCH_RETRIES = 3;
const FETCH_RETRY_DELAY_MS = 1000;

/** Retry-aware fetch for transient failures (5xx, 429, network errors). */
async function fetchWithRetry(url: string, init: RequestInit, logger?: SSELogger): Promise<Response> {
  for (let attempt = 0; attempt < MAX_FETCH_RETRIES; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.ok || !TRANSIENT_STATUS_CODES.has(res.status) || attempt === MAX_FETCH_RETRIES - 1) {
        return res;
      }
      logger?.logSSEEvent(`Transient failure (${res.status}), retrying (${attempt + 1}/${MAX_FETCH_RETRIES})...`);
    } catch (err) {
      if (attempt === MAX_FETCH_RETRIES - 1) throw err;
      logger?.logSSEEvent(`Network error, retrying (${attempt + 1}/${MAX_FETCH_RETRIES})...`);
    }
    await new Promise(resolve => setTimeout(resolve, FETCH_RETRY_DELAY_MS));
  }
  throw new Error('fetchWithRetry: exhausted retries');
}

/** Build the common headers for MCP bearer-token HTTP requests. */
function buildMcpBearerHeaders(options: McpInvokeOptions): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${options.bearerToken}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'Mcp-Protocol-Version': '2025-03-26',
    'X-Amzn-Bedrock-AgentCore-Runtime-User-Id': options.userId ?? DEFAULT_RUNTIME_USER_ID,
  };
  if (options.mcpSessionId) {
    headers['Mcp-Session-Id'] = options.mcpSessionId;
  }
  if (options.headers) {
    for (const [name, value] of Object.entries(options.headers)) {
      headers[name] = value;
    }
  }
  return headers;
}

/** Send an MCP JSON-RPC call using bearer-token auth (raw HTTP, no SigV4). */
async function mcpRpcCallWithBearer(options: McpInvokeOptions, body: Record<string, unknown>): Promise<McpRpcResult> {
  const url = buildInvokeUrl(options.region, options.runtimeArn);
  const headers = buildMcpBearerHeaders(options);

  options.logger?.logSSEEvent(`MCP request: ${JSON.stringify(body)}`);

  const res = await fetchWithRetry(url, { method: 'POST', headers, body: JSON.stringify(body) }, options.logger);

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`MCP call failed (${res.status}): ${errBody || res.statusText}`);
  }

  const text = await res.text();
  options.logger?.logSSEEvent(`MCP response: ${text}`);

  const parsed = parseJsonRpcResponse(text);

  return {
    result: (parsed.result as Record<string, unknown>) ?? {},
    mcpSessionId: res.headers.get('Mcp-Session-Id') ?? undefined,
    error: parsed.error as McpRpcResult['error'],
  };
}

/** Send an MCP JSON-RPC notification using bearer-token auth (raw HTTP, no SigV4). */
async function mcpRpcNotifyWithBearer(options: McpInvokeOptions, body: Record<string, unknown>): Promise<void> {
  const url = buildInvokeUrl(options.region, options.runtimeArn);
  const headers = buildMcpBearerHeaders(options);

  const res = await fetchWithRetry(url, { method: 'POST', headers, body: JSON.stringify(body) }, options.logger);

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`MCP notification failed (${res.status}): ${errBody || res.statusText}`);
  }
}

/** Send a JSON-RPC payload through InvokeAgentRuntime and return the parsed response. */
async function mcpRpcCall(options: McpInvokeOptions, body: Record<string, unknown>): Promise<McpRpcResult> {
  // TODO: Consider unified transport refactor (Option B) when a third auth method or A2A CUSTOM_JWT is needed.
  if (options.bearerToken) {
    return mcpRpcCallWithBearer(options, body);
  }

  const client = createAgentCoreClient(options.region, options.headers);

  options.logger?.logSSEEvent(`MCP request: ${JSON.stringify(body)}`);

  const command = new InvokeAgentRuntimeCommand({
    agentRuntimeArn: options.runtimeArn,
    payload: new TextEncoder().encode(JSON.stringify(body)),
    contentType: 'application/json',
    accept: 'application/json, text/event-stream',
    mcpSessionId: options.mcpSessionId,
    mcpProtocolVersion: '2025-03-26',
    runtimeUserId: options.userId ?? DEFAULT_RUNTIME_USER_ID,
  });

  const response = await client.send(command);

  if (!response.response) {
    throw new Error('No response from AgentCore Runtime');
  }

  const bytes = await response.response.transformToByteArray();
  const text = new TextDecoder().decode(bytes);

  options.logger?.logSSEEvent(`MCP response: ${text}`);

  const parsed = parseJsonRpcResponse(text);

  return {
    result: (parsed.result as Record<string, unknown>) ?? {},
    mcpSessionId: response.mcpSessionId,
    error: parsed.error as McpRpcResult['error'],
  };
}

/** Call mcpRpcCall and throw on JSON-RPC errors. Use mcpRpcCall directly when errors should be tolerated. */
async function mcpRpcCallStrict(options: McpInvokeOptions, body: Record<string, unknown>): Promise<McpRpcResult> {
  const result = await mcpRpcCall(options, body);
  if (result.error) {
    throw new Error(result.error.message ?? `MCP error (code ${result.error.code})`);
  }
  return result;
}

/** Send a JSON-RPC notification (no id, no response expected). */
async function mcpRpcNotify(options: McpInvokeOptions, body: Record<string, unknown>): Promise<void> {
  if (options.bearerToken) {
    return mcpRpcNotifyWithBearer(options, body);
  }

  const client = createAgentCoreClient(options.region, options.headers);

  const command = new InvokeAgentRuntimeCommand({
    agentRuntimeArn: options.runtimeArn,
    payload: new TextEncoder().encode(JSON.stringify(body)),
    contentType: 'application/json',
    accept: 'application/json, text/event-stream',
    mcpSessionId: options.mcpSessionId,
    mcpProtocolVersion: '2025-03-26',
    runtimeUserId: options.userId ?? DEFAULT_RUNTIME_USER_ID,
  });

  await client.send(command);
}

/**
 * Initialize MCP session and list available tools via InvokeAgentRuntime.
 * Retries on cold-start initialization timeouts.
 */
export async function mcpListTools(options: McpInvokeOptions): Promise<McpListToolsResult> {
  const maxRetries = 3;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await mcpListToolsOnce(options);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isColdStart = msg.includes('initialization time exceeded') || msg.includes('initialization');

      if (isColdStart && attempt < maxRetries - 1) {
        options.logger?.logSSEEvent(`MCP cold start (attempt ${attempt + 1}/${maxRetries}), retrying...`);
        await new Promise(resolve => setTimeout(resolve, 2000));
        continue;
      }
      throw err;
    }
  }

  throw new Error('Failed to list MCP tools after retries');
}

async function mcpListToolsOnce(options: McpInvokeOptions): Promise<McpListToolsResult> {
  // 1. Initialize — tolerate JSON-RPC errors (stateless servers may reject initialize but still return a session ID)
  const initResult = await mcpRpcCall(options, {
    jsonrpc: '2.0',
    id: mcpRequestId++,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'agentcore-cli', version: '1.0.0' },
    },
  });

  if (initResult.error) {
    options.logger?.logSSEEvent(
      `MCP initialize returned error (expected for stateless servers): ${initResult.error.message}`
    );
  }

  const sessionId = initResult.mcpSessionId;
  const optionsWithSession = { ...options, mcpSessionId: sessionId };

  // 2. Send initialized notification
  await mcpRpcNotify(optionsWithSession, {
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  });

  // 3. List tools
  const listResult = await mcpRpcCallStrict(optionsWithSession, {
    jsonrpc: '2.0',
    id: mcpRequestId++,
    method: 'tools/list',
    params: {},
  });

  const tools = (listResult.result as { tools?: McpToolDef[] }).tools ?? [];

  return {
    tools: tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    mcpSessionId: sessionId,
  };
}

/**
 * Initialize an MCP session (without listing tools).
 * Returns just the session ID needed for subsequent tool calls.
 */
export async function mcpInitSession(options: McpInvokeOptions): Promise<string | undefined> {
  const initResult = await mcpRpcCall(options, {
    jsonrpc: '2.0',
    id: mcpRequestId++,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'agentcore-cli', version: '1.0.0' },
    },
  });

  const sessionId = initResult.mcpSessionId;
  const optionsWithSession = { ...options, mcpSessionId: sessionId };

  await mcpRpcNotify(optionsWithSession, {
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  });

  return sessionId;
}

/**
 * Call an MCP tool via InvokeAgentRuntime.
 * Retries on cold-start initialization timeouts.
 */
export async function mcpCallTool(
  options: McpInvokeOptions,
  toolName: string,
  args: Record<string, unknown>
): Promise<string> {
  const maxRetries = 3;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const { result } = await mcpRpcCallStrict(options, {
        jsonrpc: '2.0',
        id: mcpRequestId++,
        method: 'tools/call',
        params: { name: toolName, arguments: args },
      });

      const content = (result as { content?: { type?: string; text?: string }[] }).content;
      if (content) {
        const texts: string[] = [];
        for (const item of content) {
          if (item.text !== undefined) {
            texts.push(item.text);
          }
        }
        if (texts.length > 0) return texts.join('');
      }

      return JSON.stringify(result, null, 2);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isColdStart = msg.includes('initialization time exceeded') || msg.includes('initialization');

      if (isColdStart && attempt < maxRetries - 1) {
        options.logger?.logSSEEvent(`MCP cold start (attempt ${attempt + 1}/${maxRetries}), retrying...`);
        await new Promise(resolve => setTimeout(resolve, 2000));
        continue;
      }
      throw err;
    }
  }

  throw new Error('Failed to call MCP tool after retries');
}

// ---------------------------------------------------------------------------
// A2A: JSON-RPC message/send over InvokeAgentRuntime
// ---------------------------------------------------------------------------

export interface A2AInvokeOptions {
  region: string;
  runtimeArn: string;
  userId?: string;
  sessionId?: string;
  logger?: SSELogger;
  /** Custom headers to forward to the agent runtime */
  headers?: Record<string, string>;
}

let a2aRequestId = 1;

/**
 * Invoke a deployed A2A agent via InvokeAgentRuntime with JSON-RPC message/send.
 * Streams text parts from the response artifacts.
 */
export async function invokeA2ARuntime(options: A2AInvokeOptions, message: string): Promise<StreamingInvokeResult> {
  const client = createAgentCoreClient(options.region, options.headers);

  const body = {
    jsonrpc: '2.0',
    id: a2aRequestId++,
    method: 'message/send',
    params: {
      message: {
        role: 'user',
        parts: [{ kind: 'text', text: message }],
        messageId: `msg-${Date.now()}`,
      },
    },
  };

  options.logger?.logSSEEvent(`A2A request: ${JSON.stringify(body)}`);

  const command = new InvokeAgentRuntimeCommand({
    agentRuntimeArn: options.runtimeArn,
    payload: new TextEncoder().encode(JSON.stringify(body)),
    contentType: 'application/json',
    accept: 'application/json, text/event-stream',
    runtimeUserId: options.userId ?? DEFAULT_RUNTIME_USER_ID,
    ...(options.sessionId && { runtimeSessionId: options.sessionId }),
  });

  const response = await client.send(command);

  if (!response.response) {
    throw new Error('No response from AgentCore Runtime');
  }

  const bytes = await response.response.transformToByteArray();
  const text = new TextDecoder().decode(bytes);

  options.logger?.logSSEEvent(`A2A response: ${text}`);

  const parsed = parseA2AResponse(text);

  return {
    stream: singleValueStream(parsed),
    sessionId: undefined,
  };
}

/** Wrap a single string value as an AsyncGenerator for StreamingInvokeResult compatibility. */
// eslint-disable-next-line @typescript-eslint/require-await
async function* singleValueStream(value: string): AsyncGenerator<string, void, unknown> {
  yield value;
}

/** Extract text content from A2A JSON-RPC response. Supports both kind:'text' and type:'text' part formats. */
export function parseA2AResponse(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') return text;

    const obj = parsed as Record<string, unknown>;

    // Check for JSON-RPC error
    if (obj.error && typeof obj.error === 'object') {
      const err = obj.error as { message?: string };
      return `Error: ${err.message ?? JSON.stringify(obj.error)}`;
    }

    // Extract text from result.artifacts[].parts[].text
    const result = obj.result as Record<string, unknown> | undefined;
    if (!result) return text;

    const artifacts = result.artifacts as { parts?: { kind?: string; type?: string; text?: string }[] }[] | undefined;
    if (artifacts) {
      const texts: string[] = [];
      for (const artifact of artifacts) {
        if (artifact.parts) {
          for (const part of artifact.parts) {
            if ((part.kind === 'text' || part.type === 'text') && part.text !== undefined) {
              texts.push(part.text);
            }
          }
        }
      }
      if (texts.length > 0) return texts.join('');
    }

    // Fallback: check history for the last assistant message
    const history = result.history as
      | { role?: string; parts?: { kind?: string; type?: string; text?: string }[] }[]
      | undefined;
    if (history) {
      for (let i = history.length - 1; i >= 0; i--) {
        const msg = history[i];
        if (msg?.role === 'agent' && msg.parts) {
          const agentTexts = msg.parts
            .filter(p => (p.kind === 'text' || p.type === 'text') && p.text !== undefined)
            .map(p => p.text!);
          if (agentTexts.length > 0) return agentTexts.join('');
        }
      }
    }

    return JSON.stringify(result, null, 2);
  } catch {
    return text;
  }
}

/**
 * Stop a runtime session.
 */
export async function stopRuntimeSession(options: StopRuntimeSessionOptions): Promise<StopRuntimeSessionResult> {
  const client = new BedrockAgentCoreClient({
    region: options.region,
    credentials: getCredentialProvider(),
  });

  const command = new StopRuntimeSessionCommand({
    agentRuntimeArn: options.runtimeArn,
    runtimeSessionId: options.sessionId,
  });

  const response = await client.send(command);

  return {
    sessionId: response.runtimeSessionId,
    statusCode: response.statusCode,
  };
}

// ---------------------------------------------------------------------------
// Execute Bash: Run shell commands in runtime containers
// ---------------------------------------------------------------------------

export interface ExecuteBashOptions {
  region: string;
  runtimeArn: string;
  command: string;
  sessionId?: string;
  timeout?: number;
  /** Custom headers to forward to the agent runtime */
  headers?: Record<string, string>;
  /** Bearer token for CUSTOM_JWT auth — not yet supported for exec, will throw */
  bearerToken?: string;
}

export interface ExecuteBashStreamEvent {
  type: 'start' | 'stdout' | 'stderr' | 'stop';
  data?: string;
  exitCode?: number;
  status?: string;
}

export interface ExecuteBashResult {
  stream: AsyncGenerator<ExecuteBashStreamEvent, void, unknown>;
  sessionId: string | undefined;
}

/**
 * Execute a shell command in a running AgentCore Runtime container.
 * Returns a streaming result with stdout/stderr events and exit code.
 */
export async function executeBashCommand(options: ExecuteBashOptions): Promise<ExecuteBashResult> {
  if (options.bearerToken) {
    throw new Error('Bearer token auth for exec is not yet supported. Use SigV4 credentials.');
  }

  const client = createAgentCoreClient(options.region, options.headers);

  const command = new InvokeAgentRuntimeCommandCommand({
    agentRuntimeArn: options.runtimeArn,
    runtimeSessionId: options.sessionId,
    body: {
      command: options.command,
      ...(options.timeout != null ? { timeout: options.timeout } : {}),
    },
  });

  const response = await client.send(command);
  const sessionId = response.runtimeSessionId;

  async function* streamEvents(): AsyncGenerator<ExecuteBashStreamEvent, void, unknown> {
    if (!response.stream) {
      throw new Error('No stream in response from AgentCore Runtime');
    }
    for await (const event of response.stream) {
      // SDK types for InvokeAgentRuntimeCommandCommand stream events are not yet published — cast needed until SDK stabilizes
      const chunk = (event as unknown as Record<string, unknown>).chunk as Record<string, unknown> | undefined;
      if (!chunk || typeof chunk !== 'object') continue;

      if (chunk.contentStart !== undefined) {
        yield { type: 'start' };
      }
      const delta = chunk.contentDelta as { stdout?: string; stderr?: string } | undefined;
      if (delta) {
        if (delta.stdout) {
          yield { type: 'stdout', data: delta.stdout };
        }
        if (delta.stderr) {
          yield { type: 'stderr', data: delta.stderr };
        }
      }
      const stop = chunk.contentStop as { exitCode?: number; status?: string } | undefined;
      if (stop) {
        yield {
          type: 'stop',
          exitCode: stop.exitCode,
          status: stop.status,
        };
      }
    }
  }

  return { stream: streamEvents(), sessionId };
}
