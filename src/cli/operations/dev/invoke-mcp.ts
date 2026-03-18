import { parseJsonRpcResponse } from '../../../lib/utils/json-rpc';
import { ConnectionError, type SSELogger, ServerError } from './invoke-types';
import { isConnectionError, sleep } from './utils';

let requestId = 1;

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpToolsResult {
  tools: McpTool[];
  sessionId?: string;
}

/**
 * Initialize MCP session and list available tools.
 * Sends initialize + tools/list JSON-RPC requests to the MCP endpoint.
 * Returns tools and the session ID needed for subsequent calls.
 */
export async function listMcpTools(port: number, logger?: SSELogger): Promise<McpToolsResult> {
  const maxRetries = 5;
  const baseDelay = 500;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // 1. Initialize session
      const initBody = {
        jsonrpc: '2.0',
        id: requestId++,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'agentcore-cli', version: '1.0.0' },
        },
      };

      logger?.log?.('system', 'MCP initialize');

      const initRes = await fetch(`http://localhost:${port}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify(initBody),
      });

      if (!initRes.ok) {
        const body = await initRes.text();
        throw new ServerError(initRes.status, body);
      }

      // Extract session ID from response header
      const sessionId = initRes.headers.get('mcp-session-id');
      const initResponseText = await initRes.text();
      logger?.logSSEEvent(initResponseText);

      // 2. Send initialized notification
      const initializedBody = {
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      };

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (sessionId) headers['mcp-session-id'] = sessionId;

      await fetch(`http://localhost:${port}/mcp`, {
        method: 'POST',
        headers,
        body: JSON.stringify(initializedBody),
      });

      // 3. List tools
      const listBody = {
        jsonrpc: '2.0',
        id: requestId++,
        method: 'tools/list',
        params: {},
      };

      logger?.log?.('system', 'MCP tools/list');

      const listRes = await fetch(`http://localhost:${port}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
        body: JSON.stringify(listBody),
      });

      if (!listRes.ok) {
        const body = await listRes.text();
        throw new ServerError(listRes.status, body);
      }

      const listResponseText = await listRes.text();
      logger?.logSSEEvent(listResponseText);

      const parsed = parseJsonRpcResponse(listResponseText);
      const result = parsed.result as { tools?: McpTool[] } | undefined;
      const tools = result?.tools ?? [];

      return {
        tools: tools.map(t => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
        sessionId: sessionId ?? undefined,
      };
    } catch (err) {
      if (err instanceof ServerError) {
        logger?.log?.('error', `Server error (${err.statusCode}): ${err.message}`);
        throw err;
      }

      lastError = err instanceof Error ? err : new Error(String(err));

      if (isConnectionError(lastError)) {
        const delay = baseDelay * Math.pow(2, attempt);
        logger?.log?.(
          'warn',
          `Connection failed (attempt ${attempt + 1}/${maxRetries}): ${lastError.message}. Retrying in ${delay}ms...`
        );
        await sleep(delay);
        continue;
      }

      logger?.log?.('error', `Request failed: ${lastError.stack ?? lastError.message}`);
      throw lastError;
    }
  }

  const finalError = new ConnectionError(lastError ?? new Error('Failed to connect to MCP server after retries'));
  logger?.log?.('error', `Failed to connect after ${maxRetries} attempts: ${finalError.message}`);
  throw finalError;
}

/**
 * Call an MCP tool by name with JSON arguments.
 * Requires a session ID from a previous initialize call.
 */
export async function callMcpTool(
  port: number,
  toolName: string,
  args: Record<string, unknown>,
  sessionId?: string,
  logger?: SSELogger
): Promise<string> {
  const body = {
    jsonrpc: '2.0',
    id: requestId++,
    method: 'tools/call',
    params: { name: toolName, arguments: args },
  };

  logger?.log?.('system', `MCP tools/call: ${toolName}(${JSON.stringify(args)})`);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;

  const res = await fetch(`http://localhost:${port}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const responseBody = await res.text();
    throw new ServerError(res.status, responseBody);
  }

  const responseText = await res.text();
  logger?.logSSEEvent(responseText);

  const parsed = parseJsonRpcResponse(responseText);

  if (parsed.error) {
    const rpcError = parsed.error as { message?: string; code?: number };
    throw new Error(rpcError.message ?? `MCP error (code ${rpcError.code})`);
  }

  const result = parsed.result as { content?: { type?: string; text?: string }[] } | undefined;
  if (result?.content) {
    const texts: string[] = [];
    for (const item of result.content) {
      if (item.text !== undefined) {
        texts.push(item.text);
      }
    }
    if (texts.length > 0) return texts.join('');
  }

  return JSON.stringify(parsed.result, null, 2);
}
