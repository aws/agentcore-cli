import { ConnectionError, type InvokeStreamingOptions, type SSELogger, ServerError } from './invoke-types';
import { isConnectionError, sleep } from './utils';
import { randomUUID } from 'crypto';

let requestId = 1;

export interface A2AAgentCard {
  name?: string;
  description?: string;
  version?: string;
  url?: string;
  skills?: { id?: string; name?: string; description?: string; tags?: string[] }[];
  capabilities?: { streaming?: boolean };
  defaultInputModes?: string[];
  defaultOutputModes?: string[];
}

/**
 * Fetch the A2A agent card from /.well-known/agent.json.
 * Returns null if not available (retries on connection errors).
 */
export async function fetchA2AAgentCard(port: number, logger?: SSELogger): Promise<A2AAgentCard | null> {
  const maxRetries = 5;
  const baseDelay = 500;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const res = await fetch(`http://localhost:${port}/.well-known/agent.json`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });

      if (!res.ok) {
        logger?.log?.('warn', `Agent card not available (${res.status})`);
        return null;
      }

      const card = (await res.json()) as A2AAgentCard;
      logger?.log?.('system', `A2A agent card: ${card.name ?? 'unnamed'}`);
      return card;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (isConnectionError(error) && attempt < maxRetries - 1) {
        const delay = baseDelay * Math.pow(2, attempt);
        await sleep(delay);
        continue;
      }

      logger?.log?.('warn', `Failed to fetch agent card: ${error.message}`);
      return null;
    }
  }

  return null;
}

/**
 * Invokes an A2A agent using JSON-RPC 2.0 message/stream (SSE) with
 * fallback to message/send (non-streaming).
 * Yields text chunks as they arrive from artifact-update and status-update events.
 */
export async function* invokeA2AStreaming(options: InvokeStreamingOptions): AsyncGenerator<string, void, unknown> {
  const { port, message: msg, logger, onStatus, headers: customHeaders } = options;
  const maxRetries = 5;
  const baseDelay = 500;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const body = {
        jsonrpc: '2.0',
        id: requestId++,
        method: 'message/stream',
        params: {
          message: {
            messageId: randomUUID(),
            role: 'user',
            parts: [{ kind: 'text', text: msg }],
          },
        },
      };

      logger?.log?.('system', `A2A message/stream: ${msg}`);

      const res = await fetch(`http://localhost:${port}/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...customHeaders },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const responseBody = await res.text();
        throw new ServerError(res.status, responseBody);
      }

      const contentType = res.headers.get('content-type') ?? '';

      // Handle SSE streaming response
      if (contentType.includes('text/event-stream') && res.body) {
        yield* parseA2ASSEStream(res.body, logger, onStatus);
        return;
      }

      // Handle non-streaming JSON-RPC response (fallback)
      const responseText = await res.text();
      logger?.logSSEEvent(responseText);

      try {
        const json = JSON.parse(responseText) as Record<string, unknown>;

        if (json.error) {
          const rpcError = json.error as { message?: string; code?: number };
          throw new ServerError(rpcError.code ?? 500, rpcError.message ?? 'A2A RPC error');
        }

        const result = json.result as Record<string, unknown> | undefined;
        if (result) {
          const text = extractTaskText(result);
          if (text) {
            yield text;
          } else {
            yield JSON.stringify(result, null, 2);
          }
        } else {
          yield responseText;
        }
      } catch (e) {
        if (e instanceof ServerError) throw e;
        yield responseText;
      }

      return;
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

  const finalError = new ConnectionError(lastError ?? new Error('Failed to connect to A2A server after retries'));
  logger?.log?.('error', `Failed to connect after ${maxRetries} attempts: ${finalError.message}`);
  throw finalError;
}

/** Parse SSE stream from A2A message/stream response */
async function* parseA2ASSEStream(
  body: ReadableStream<Uint8Array>,
  logger?: SSELogger,
  onStatus?: (status: string) => void
): AsyncGenerator<string, void, unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let streamedFromStatus = false;

  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;

      buffer += decoder.decode(result.value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (!data) continue;

        logger?.logSSEEvent(line);

        try {
          const event = JSON.parse(data) as Record<string, unknown>;
          handleSSEEvent(event, onStatus);
          const text = extractSSEEventText(event, streamedFromStatus);
          if (text) {
            if (isStatusUpdateEvent(event)) streamedFromStatus = true;
            yield text;
          }
        } catch {
          yield data;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Dispatch status-update events to the onStatus callback */
function handleSSEEvent(event: Record<string, unknown>, onStatus?: (status: string) => void): void {
  if (!onStatus) return;
  const target = (event.result as Record<string, unknown>) ?? event;
  if (target.kind !== 'status-update') return;
  const status = target.status as { state?: string } | undefined;
  if (status?.state) {
    onStatus(status.state);
  }
}

/** Check if an event (possibly wrapped in JSON-RPC envelope) is a status-update */
export function isStatusUpdateEvent(event: Record<string, unknown>): boolean {
  const target = (event.result as Record<string, unknown>) ?? event;
  return target.kind === 'status-update';
}

/**
 * Extract displayable text from an A2A SSE event.
 *
 * Events come in two forms:
 * - artifact-update: { kind: 'artifact-update', artifact: { parts: [{ kind: 'text', text: '...' }] } }
 * - status-update:   { kind: 'status-update', status: { state: '...', message?: { parts: [...] } }, final: bool }
 *
 * Events can also be wrapped in a JSON-RPC result envelope.
 *
 * When `streamedFromStatus` is true, artifact-update text is skipped because
 * the same content was already streamed incrementally via status-update events.
 */
export function extractSSEEventText(event: Record<string, unknown>, streamedFromStatus = false): string | null {
  // Unwrap JSON-RPC result envelope if present
  const target = (event.result as Record<string, unknown>) ?? event;
  const kind = target.kind as string | undefined;

  if (kind === 'artifact-update') {
    // Skip if we already streamed this content via status-update events
    if (streamedFromStatus) return null;
    const artifact = target.artifact as { parts?: { kind?: string; text?: string }[] } | undefined;
    return extractPartsText(artifact?.parts);
  }

  if (kind === 'status-update') {
    // Extract streaming text from status-update message parts (working state)
    const status = target.status as
      | { state?: string; message?: { parts?: { kind?: string; type?: string; text?: string }[] } }
      | undefined;
    if (status?.message?.parts) {
      return extractPartsText(status.message.parts);
    }
    return null;
  }

  // Fallback: try extracting from a full Task result (non-streaming envelope)
  return extractTaskText(target);
}

/** Extract text from a full Task result (has artifacts array and/or status) */
export function extractTaskText(result: Record<string, unknown>): string | null {
  // Try artifacts first
  const artifacts = result.artifacts as { parts?: { kind?: string; type?: string; text?: string }[] }[] | undefined;
  if (artifacts) {
    const texts: string[] = [];
    for (const artifact of artifacts) {
      const text = extractPartsText(artifact.parts);
      if (text) texts.push(text);
    }
    if (texts.length > 0) return texts.join('\n');
  }

  // Try status message
  const status = result.status as { message?: { parts?: { kind?: string; text?: string }[] } } | undefined;
  if (status?.message?.parts) {
    return extractPartsText(status.message.parts);
  }

  return null;
}

/** Extract text from a parts array (supports both kind:'text' and type:'text' formats) */
function extractPartsText(parts: { kind?: string; type?: string; text?: string }[] | undefined): string | null {
  if (!parts) return null;
  const texts: string[] = [];
  for (const part of parts) {
    if ((part.kind === 'text' || part.type === 'text') && part.text) {
      texts.push(part.text);
    }
  }
  return texts.length > 0 ? texts.join('') : null;
}
