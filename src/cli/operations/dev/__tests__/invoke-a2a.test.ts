import { ServerError } from '../invoke';
import { invokeA2AStreaming } from '../invoke-a2a';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('invokeA2AStreaming', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('sends message/stream JSON-RPC and yields artifact text', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Map([['content-type', 'application/json']]),
      body: null,
      text: () =>
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            id: 'task-1',
            status: { state: 'completed' },
            artifacts: [
              {
                parts: [{ type: 'text', text: 'The answer is 4.' }],
              },
            ],
          },
        }),
    });

    const chunks: string[] = [];
    for await (const chunk of invokeA2AStreaming({ port: 8080, message: 'what is 2+2' })) {
      chunks.push(chunk);
    }

    expect(chunks.join('')).toBe('The answer is 4.');

    // Verify the request format
    const call = mockFetch.mock.calls[0]!;
    expect(call[0]).toBe('http://localhost:8080/');
    const body = JSON.parse(call[1]!.body);
    expect(body.method).toBe('message/stream');
    expect(body.params.message.messageId).toBeDefined();
    expect(body.params.message.parts[0].kind).toBe('text');
    expect(body.params.message.parts[0].text).toBe('what is 2+2');
  });

  it('retries on connection errors', async () => {
    // First attempt fails
    mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));

    // Second attempt succeeds
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Map([['content-type', 'application/json']]),
      body: null,
      text: () =>
        JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          result: {
            artifacts: [{ parts: [{ type: 'text', text: 'ok' }] }],
          },
        }),
    });

    const chunks: string[] = [];
    for await (const chunk of invokeA2AStreaming({ port: 8080, message: 'hello' })) {
      chunks.push(chunk);
    }

    expect(chunks.join('')).toBe('ok');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('throws ServerError on HTTP error without retrying', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => 'Internal Server Error',
    });

    const gen = invokeA2AStreaming({ port: 8080, message: 'test' });
    await expect(gen.next()).rejects.toThrow(ServerError);
  });

  it('handles JSON-RPC error in response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Map([['content-type', 'application/json']]),
      body: null,
      text: () =>
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          error: { code: -32600, message: 'Bad request' },
        }),
    });

    const gen = invokeA2AStreaming({ port: 8080, message: 'test' });
    await expect(gen.next()).rejects.toThrow(ServerError);
  });

  it('streams text from status-update events and skips duplicate artifact-update', async () => {
    // Simulate SSE stream with status-update chunks followed by artifact-update
    const sseLines = [
      'data: {"kind":"status-update","status":{"state":"working","message":{"parts":[{"kind":"text","text":"Hello"}]}}}\n\n',
      'data: {"kind":"status-update","status":{"state":"working","message":{"parts":[{"kind":"text","text":" world"}]}}}\n\n',
      'data: {"kind":"artifact-update","artifact":{"parts":[{"kind":"text","text":"Hello world"}]}}\n\n',
      'data: {"kind":"status-update","status":{"state":"completed"},"final":true}\n\n',
    ];

    const encoder = new TextEncoder();
    let chunkIndex = 0;
    const mockBody = {
      getReader: () => ({
        read: () => {
          if (chunkIndex < sseLines.length) {
            return Promise.resolve({ done: false as const, value: encoder.encode(sseLines[chunkIndex++]) });
          }
          return Promise.resolve({ done: true as const, value: undefined });
        },
        releaseLock: vi.fn(),
      }),
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Map([['content-type', 'text/event-stream']]),
      body: mockBody,
    });

    const chunks: string[] = [];
    const statuses: string[] = [];
    for await (const chunk of invokeA2AStreaming({
      port: 8080,
      message: 'hello',
      onStatus: s => statuses.push(s),
    })) {
      chunks.push(chunk);
    }

    // Should yield incremental status-update text, not the duplicate artifact-update
    expect(chunks).toEqual(['Hello', ' world']);
    expect(chunks.join('')).toBe('Hello world');
    // Should have received status callbacks
    expect(statuses).toContain('working');
    expect(statuses).toContain('completed');
  });

  it('yields artifact-update text when no status-update text was streamed', async () => {
    // SSE stream with only artifact-update (no streaming status-update text)
    const sseLines = [
      'data: {"kind":"status-update","status":{"state":"working"}}\n\n',
      'data: {"kind":"artifact-update","artifact":{"parts":[{"kind":"text","text":"Result here"}]}}\n\n',
      'data: {"kind":"status-update","status":{"state":"completed"},"final":true}\n\n',
    ];

    const encoder = new TextEncoder();
    let chunkIndex = 0;
    const mockBody = {
      getReader: () => ({
        read: () => {
          if (chunkIndex < sseLines.length) {
            return Promise.resolve({ done: false as const, value: encoder.encode(sseLines[chunkIndex++]) });
          }
          return Promise.resolve({ done: true as const, value: undefined });
        },
        releaseLock: vi.fn(),
      }),
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Map([['content-type', 'text/event-stream']]),
      body: mockBody,
    });

    const chunks: string[] = [];
    for await (const chunk of invokeA2AStreaming({ port: 8080, message: 'hello' })) {
      chunks.push(chunk);
    }

    // Should yield artifact-update text since no status-update text was streamed
    expect(chunks).toEqual(['Result here']);
  });

  it('yields fallback JSON when no artifacts found', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Map([['content-type', 'application/json']]),
      body: null,
      text: () =>
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { id: 'task-1', status: { state: 'completed' } },
        }),
    });

    const chunks: string[] = [];
    for await (const chunk of invokeA2AStreaming({ port: 8080, message: 'test' })) {
      chunks.push(chunk);
    }

    // Should yield the stringified result as fallback
    expect(chunks.length).toBeGreaterThan(0);
  });
});
