import type { SSELogger } from '../operations/dev/invoke-types';
import { AguiEventType, parseAguiEvent } from './agui-types';
import type { AguiEvent, AguiTextMessageContent } from './agui-types';

export interface ParseAguiSSEOptions {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  logger?: SSELogger;
  singleConsumer?: boolean;
}

export interface AguiSSEStreams {
  eventStream: AsyncGenerator<AguiEvent, void, unknown>;
  textStream?: AsyncGenerator<string, void, unknown>;
}

export function parseAguiSSEStream(options: ParseAguiSSEOptions): AguiSSEStreams {
  const { reader, logger, singleConsumer = false } = options;
  const decoder = new TextDecoder();

  const events: AguiEvent[] = [];
  const waiters: (() => void)[] = [];
  let done = false;
  let readError: Error | undefined;
  let eventCursor = 0;
  let textCursor = singleConsumer ? -1 : 0;

  function notify() {
    for (const w of waiters.splice(0)) w();
  }

  function prune() {
    const minCursor = textCursor === -1 ? eventCursor : Math.min(eventCursor, textCursor);
    if (minCursor > 0) {
      events.splice(0, minCursor);
      eventCursor -= minCursor;
      if (textCursor !== -1) textCursor -= minCursor;
    }
  }

  const readLoop = (async () => {
    let buffer = '';
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;

        buffer += decoder.decode(result.value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (logger && line.trim()) {
            logger.logSSEEvent(line);
          }
          const event = parseAguiEvent(line);
          if (event) {
            events.push(event);
            notify();
          }
        }
      }
      if (buffer.trim()) {
        if (logger) logger.logSSEEvent(buffer);
        const event = parseAguiEvent(buffer);
        if (event) events.push(event);
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // already released
      }
      done = true;
      notify();
    }
  })();

  readLoop.catch((err: unknown) => {
    readError = err instanceof Error ? err : new Error(String(err));
    done = true;
    notify();
  });

  async function* makeEventStream(): AsyncGenerator<AguiEvent, void, unknown> {
    while (true) {
      if (eventCursor < events.length) {
        const event = events[eventCursor++]!;
        prune();
        yield event;
      } else if (done) {
        if (readError) throw readError;
        return;
      } else {
        await new Promise<void>(resolve => waiters.push(resolve));
      }
    }
  }

  async function* makeTextStream(): AsyncGenerator<string, void, unknown> {
    while (true) {
      if (textCursor < events.length) {
        const event = events[textCursor++]!;
        prune();
        if (event.type === AguiEventType.TEXT_MESSAGE_CONTENT || event.type === AguiEventType.TEXT_MESSAGE_CHUNK) {
          const delta = (event as AguiTextMessageContent).delta;
          if (delta) yield delta;
        } else if (event.type === AguiEventType.RUN_ERROR) {
          yield `Error: ${event.message}`;
        }
      } else if (done) {
        if (readError) throw readError;
        return;
      } else {
        await new Promise<void>(resolve => waiters.push(resolve));
      }
    }
  }

  return {
    eventStream: makeEventStream(),
    textStream: singleConsumer ? undefined : makeTextStream(),
  };
}
