import { invokeA2AStreaming } from './invoke-a2a';
import { ConnectionError, type InvokeStreamingOptions, type SSELogger, ServerError } from './invoke-types';
import { isConnectionError, sleep } from './utils';

// Re-export shared types so existing consumers don't break
export { ConnectionError, ServerError, type InvokeStreamingOptions, type SSELogger } from './invoke-types';

/**
 * Parse a single SSE data line and extract the content.
 */
function parseSSELine(line: string): { content: string | null; error: string | null } {
  if (!line.startsWith('data: ')) {
    return { content: null, error: null };
  }
  const content = line.slice(6);
  try {
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed === 'string') {
      return { content: parsed, error: null };
    } else if (parsed && typeof parsed === 'object') {
      if ('error' in parsed) {
        return { content: null, error: String((parsed as { error: unknown }).error) };
      }
      // Handle {"text": "..."} format from bedrock-agentcore runtime
      if ('text' in parsed) {
        return { content: String((parsed as { text: unknown }).text), error: null };
      }
    }
  } catch {
    return { content, error: null };
  }
  return { content: null, error: null };
}

/**
 * Parses Server-Sent Events (SSE) formatted text into combined content.
 * SSE format: "data: content\n\ndata: more content\n\n"
 */
function parseSSE(text: string): string {
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
  return parts.length > 0 ? parts.join('') : text;
}

/**
 * Extract result from a JSON response object.
 * Handles both {"result": "..."} and plain text responses.
 */
function extractResult(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && 'result' in parsed) {
      const result = (parsed as { result: unknown }).result;
      return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    }
    return JSON.stringify(parsed, null, 2);
  } catch {
    return text;
  }
}

/**
 * Invokes an agent on the local dev server and streams the response.
 * Yields text chunks as they arrive from the SSE stream.
 * Also handles non-streaming JSON responses from frameworks that don't support streaming.
 */
export async function* invokeAgentStreaming(
  portOrOptions: number | InvokeStreamingOptions,
  message?: string
): AsyncGenerator<string, void, unknown> {
  // Support both old signature (port, message) and new signature (options)
  const options: InvokeStreamingOptions =
    typeof portOrOptions === 'number' ? { port: portOrOptions, message: message! } : portOrOptions;
  const { port, message: msg, logger, headers: customHeaders } = options;
  const maxRetries = 5;
  const baseDelay = 500;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const res = await fetch(`http://localhost:${port}/invocations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          'x-amzn-bedrock-agentcore-runtime-session-id': 'local-dev-session',
          ...customHeaders,
        },
        body: JSON.stringify({ prompt: msg }),
      });

      if (!res.ok) {
        const body = await res.text();
        throw new ServerError(res.status, body);
      }

      if (!res.body) {
        yield '(empty response)';
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let fullResponse = '';
      let yieldedContent = false;

      try {
        while (true) {
          const result = await reader.read();
          if (result.done) break;

          const chunk = result.value as Uint8Array;
          const decoded = decoder.decode(chunk, { stream: true });
          buffer += decoded;
          fullResponse += decoded;

          // Process complete lines from buffer
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

        // Process remaining buffer for SSE content
        if (buffer) {
          // Log raw SSE line if logger provided
          if (logger && buffer.trim()) {
            logger.logSSEEvent(buffer);
          }
          const { content, error } = parseSSELine(buffer);
          if (error) {
            yield `Error: ${error}`;
            return;
          } else if (content) {
            yield content;
            yieldedContent = true;
          }
        }

        // If no SSE content was found, treat as plain JSON response
        if (!yieldedContent && fullResponse.trim()) {
          yield extractResult(fullResponse.trim());
        }
      } finally {
        reader.releaseLock();
      }

      return;
    } catch (err) {
      // Re-throw ServerError directly — no retries for HTTP errors
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

      // Log non-connection errors with full stack trace before throwing
      logger?.log?.('error', `Request failed: ${lastError.stack ?? lastError.message}`);
      throw lastError;
    }
  }

  // Log final failure after all retries exhausted with full details
  const finalError = new ConnectionError(lastError ?? new Error('Failed to connect to dev server after retries'));
  logger?.log?.('error', `Failed to connect after ${maxRetries} attempts: ${finalError.message}`);
  throw finalError;
}

export interface InvokeOptions {
  port: number;
  message: string;
  /** Optional logger for error logging */
  logger?: SSELogger;
  /** Custom headers to forward to the agent */
  headers?: Record<string, string>;
}

/**
 * Protocol-aware invoke dispatcher.
 * Routes to the appropriate invoke implementation based on protocol.
 * MCP uses a separate tool-based interface (listMcpTools/callMcpTool).
 */
export async function* invokeForProtocol(
  protocol: string,
  options: InvokeStreamingOptions
): AsyncGenerator<string, void, unknown> {
  switch (protocol) {
    case 'MCP':
      throw new Error('Use listMcpTools/callMcpTool for MCP agents');
    case 'A2A':
      yield* invokeA2AStreaming(options);
      break;
    default:
      yield* invokeAgentStreaming(options);
  }
}

/**
 * Invokes an agent running on the local dev server.
 * Handles both JSON and streaming text responses.
 * Includes retry logic for server startup race conditions.
 */
export async function invokeAgent(portOrOptions: number | InvokeOptions, message?: string): Promise<string> {
  // Support both old signature (port, message) and new signature (options)
  const options: InvokeOptions =
    typeof portOrOptions === 'number' ? { port: portOrOptions, message: message! } : portOrOptions;
  const { port, message: msg, logger, headers: customHeaders } = options;

  const maxRetries = 5;
  const baseDelay = 500; // ms
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const res = await fetch(`http://localhost:${port}/invocations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          'x-amzn-bedrock-agentcore-runtime-session-id': 'local-dev-session',
          ...customHeaders,
        },
        body: JSON.stringify({ prompt: msg }),
      });

      if (!res.ok) {
        const body = await res.text();
        throw new ServerError(res.status, body);
      }

      const text = await res.text();
      if (!text) {
        return '(empty response)';
      }

      // Check if it's SSE format (streaming response)
      if (text.includes('data: ')) {
        return parseSSE(text);
      }

      // Handle plain JSON response (non-streaming frameworks)
      return extractResult(text);
    } catch (err) {
      // Re-throw ServerError directly — no retries for HTTP errors
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

      // Log non-connection errors with full stack trace before throwing
      logger?.log?.('error', `Request failed: ${lastError.stack ?? lastError.message}`);
      throw lastError;
    }
  }

  // Log final failure after all retries exhausted with full details
  const finalError = new ConnectionError(lastError ?? new Error('Failed to connect to dev server after retries'));
  logger?.log?.('error', `Failed to connect after ${maxRetries} attempts: ${finalError.message}`);
  throw finalError;
}
