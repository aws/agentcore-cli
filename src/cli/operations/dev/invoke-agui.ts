import { parseAguiSSEStream } from '../../aws/agui-parser';
import { AguiEventType } from '../../aws/agui-types';
import { ConnectionError, type InvokeStreamingOptions, ServerError } from './invoke-types';
import { isConnectionError, sleep } from './utils';
import { randomUUID } from 'crypto';

export async function* invokeAguiStreaming(options: InvokeStreamingOptions): AsyncGenerator<string, void, unknown> {
  const { port, message: msg, logger, headers: customHeaders } = options;
  const maxRetries = 5;
  const baseDelay = 500;
  let lastError: Error | null = null;
  let streaming = false;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const body = {
        threadId: options.threadId ?? randomUUID(),
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

      const { eventStream } = parseAguiSSEStream({
        reader: res.body.getReader(),
        logger,
        singleConsumer: true,
      });

      let yieldedContent = false;
      const toolCalls: { id: string; name: string; args: string }[] = [];
      let activeToolId = '';
      let activeToolName = '';
      let activeToolArgs = '';

      for await (const event of eventStream) {
        switch (event.type) {
          case AguiEventType.TEXT_MESSAGE_CONTENT:
          case AguiEventType.TEXT_MESSAGE_CHUNK: {
            const delta = (event as { delta?: string }).delta;
            if (delta) {
              streaming = true;
              yield delta;
              yieldedContent = true;
            }
            break;
          }
          case AguiEventType.TOOL_CALL_START: {
            activeToolId = 'toolCallId' in event ? event.toolCallId : '';
            activeToolName = 'toolCallName' in event ? event.toolCallName : '';
            activeToolArgs = '';
            break;
          }
          case AguiEventType.TOOL_CALL_ARGS: {
            const delta = 'delta' in event ? event.delta : undefined;
            if (delta) activeToolArgs += delta;
            break;
          }
          case AguiEventType.TOOL_CALL_END: {
            if (activeToolName) {
              toolCalls.push({ id: activeToolId, name: activeToolName, args: activeToolArgs });
            }
            activeToolId = '';
            activeToolName = '';
            activeToolArgs = '';
            break;
          }
          case AguiEventType.TOOL_CALL_RESULT: {
            const content = 'content' in event ? event.content : undefined;
            const toolCallId = 'toolCallId' in event ? event.toolCallId : '';
            const matching = toolCalls.find(tc => tc.id === toolCallId);
            if (matching && content) {
              matching.args = `${matching.args} → ${typeof content === 'string' ? content : JSON.stringify(content)}`;
            }
            break;
          }
          case AguiEventType.RUN_ERROR: {
            const message = 'message' in event ? event.message : 'Unknown AGUI error';
            yield `Error: ${message}`;
            return;
          }
          default:
            break;
        }
      }

      if (!yieldedContent && toolCalls.length > 0) {
        for (const tc of toolCalls) {
          yield `[Tool: ${tc.name}(${tc.args})]\n`;
        }
        yieldedContent = true;
      }

      if (!yieldedContent) {
        yield '(no content in AGUI response)';
      }

      return;
    } catch (err) {
      if (err instanceof ServerError) {
        logger?.log?.('error', `Server error (${err.statusCode}): ${err.message}`);
        throw err;
      }

      lastError = err instanceof Error ? err : new Error(String(err));

      if (streaming) {
        throw lastError;
      }

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
