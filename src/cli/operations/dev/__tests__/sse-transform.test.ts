import { pipeSSETransformed } from '../sse-transform';
import { type IncomingMessage, type ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

function createMockInput(): PassThrough & { headers: Record<string, string> } {
  const stream = new PassThrough() as PassThrough & { headers: Record<string, string> };
  stream.headers = {};
  return stream;
}

function createMockOutput(): { chunks: string[]; ended: boolean; write: (data: string) => boolean; end: () => void } {
  const mock = {
    chunks: [] as string[],
    ended: false,
    write: (data: string) => {
      mock.chunks.push(data);
      return true;
    },
    end: () => {
      mock.ended = true;
    },
  };
  return mock;
}

describe('pipeSSETransformed', () => {
  it('transforms ConverseStream events to plain text SSE', async () => {
    const input = createMockInput();
    const output = createMockOutput();

    const done = pipeSSETransformed(input as unknown as IncomingMessage, output as unknown as ServerResponse);

    input.write('data: {"event":{"contentBlockDelta":{"delta":{"text":"Hello"}}}}\n\n');
    input.write('data: {"event":{"contentBlockDelta":{"delta":{"text":" world"}}}}\n\n');
    input.end();

    await done;

    expect(output.chunks).toEqual(['data: "Hello"\n\n', 'data: " world"\n\n']);
    expect(output.ended).toBe(true);
  });

  it('passes through already-parsed string events', async () => {
    const input = createMockInput();
    const output = createMockOutput();

    const done = pipeSSETransformed(input as unknown as IncomingMessage, output as unknown as ServerResponse);

    input.write('data: "simple text"\n\n');
    input.end();

    await done;

    expect(output.chunks).toEqual(['data: "simple text"\n\n']);
  });

  it('forwards errors as JSON objects', async () => {
    const input = createMockInput();
    const output = createMockOutput();

    const done = pipeSSETransformed(input as unknown as IncomingMessage, output as unknown as ServerResponse);

    input.write('data: {"error":"something broke"}\n\n');
    input.end();

    await done;

    expect(output.chunks).toEqual(['data: {"error":"something broke"}\n\n']);
  });

  it('handles chunked data split across boundaries', async () => {
    const input = createMockInput();
    const output = createMockOutput();

    const done = pipeSSETransformed(input as unknown as IncomingMessage, output as unknown as ServerResponse);

    input.write('data: {"event":{"contentBlock');
    input.write('Delta":{"delta":{"text":"split"}}}}\n\n');
    input.end();

    await done;

    expect(output.chunks).toEqual(['data: "split"\n\n']);
  });

  it('handles {"text": "..."} format from bedrock runtime', async () => {
    const input = createMockInput();
    const output = createMockOutput();

    const done = pipeSSETransformed(input as unknown as IncomingMessage, output as unknown as ServerResponse);

    input.write('data: {"text":"bedrock response"}\n\n');
    input.end();

    await done;

    expect(output.chunks).toEqual(['data: "bedrock response"\n\n']);
  });

  it('rejects on input error', async () => {
    const input = createMockInput();
    const output = createMockOutput();

    const done = pipeSSETransformed(input as unknown as IncomingMessage, output as unknown as ServerResponse);

    input.destroy(new Error('connection reset'));

    await expect(done).rejects.toThrow('connection reset');
  });
});
