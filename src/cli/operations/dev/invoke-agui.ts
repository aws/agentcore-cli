import { ConnectionError, type InvokeStreamingOptions, ServerError } from './invoke-types';
import { isConnectionError, sleep } from './utils';
import { randomUUID } from 'crypto';

/**
 * Invokes an AGUI agent on the local dev server and streams text content.
 * Sends a RunAgentInput body (not {prompt: string}) and parses AGUI SSE events,
 * yielding only TEXT_MESSAGE_CONTENT deltas as text chunks.
 */
export async function* invokeAguiStreaming(options: InvokeStreamingOptions): AsyncGenerator<string, void, unknown> {
  const { port, message: msg, logger, headers: customHeaders } = options;
  const maxRetries = 5;
  const baseDelay = 500;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // Construct RunAgentInput body (AGUI format, not {prompt: string})
      const body = {
        threadId: randomUUID(),
        runId: randomUUID(),
        messages: [{ id: randomUUID(), role: 'user', content: msg }],
        tools: [],
        context: [],
        state: {},
        forwardedProps: {},
      };

      logger?.log?.('system', `AGUI invoke: ${msg}`);

      const res = await fetch(`http://localhost:${port}/invocations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          ...customHeaders,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const responseBody = await res.text();
        throw new ServerError(res.status, responseBody);
      }

      if (!res.body) {
        yield '(empty response)';
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let yieldedContent = false;

      try {
        while (true) {
          const result = await reader.read();
          if (result.done) break;

          buffer += decoder.decode(result.value as Uint8Array, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;

            if (logger && line.trim()) {
              logger.logSSEEvent(line);
            }

            const jsonStr = line.slice(6).trim();
            if (!jsonStr) continue;

            try {
              const event = JSON.parse(jsonStr) as { type?: string; delta?: string; message?: string };

              if (event.type === 'TEXT_MESSAGE_CONTENT' && event.delta) {
                yield event.delta;
                yieldedContent = true;
              } else if (event.type === 'RUN_ERROR') {
                yield `Error: ${event.message ?? 'Unknown AGUI error'}`;
                return;
              }
            } catch {
              // Non-JSON data line — yield raw
              yield jsonStr;
              yieldedContent = true;
            }
          }
        }

        if (!yieldedContent) {
          yield '(no content in AGUI response)';
        }
      } finally {
        reader.releaseLock();
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

  const finalError = new ConnectionError(lastError ?? new Error('Failed to connect to AGUI server after retries'));
  logger?.log?.('error', `Failed to connect after ${maxRetries} attempts: ${finalError.message}`);
  throw finalError;
}
