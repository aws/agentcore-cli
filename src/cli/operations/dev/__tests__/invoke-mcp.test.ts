import { ServerError } from '../invoke';
import { callMcpTool, listMcpTools } from '../invoke-mcp';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('listMcpTools', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('sends initialize + tools/list and returns parsed tools', async () => {
    // Mock initialize response
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Map([['mcp-session-id', 'test-session']]),
      text: () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26' } }),
    });

    // Mock initialized notification response
    mockFetch.mockResolvedValueOnce({ ok: true, text: () => '' });

    // Mock tools/list response
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () =>
        JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          result: {
            tools: [
              {
                name: 'add_numbers',
                description: 'Add two numbers',
                inputSchema: { properties: { a: { type: 'integer' }, b: { type: 'integer' } } },
              },
              { name: 'greet', description: 'Say hello' },
            ],
          },
        }),
    });

    const result = await listMcpTools(8080);

    expect(result.tools).toHaveLength(2);
    expect(result.tools[0]!.name).toBe('add_numbers');
    expect(result.tools[0]!.description).toBe('Add two numbers');
    expect(result.tools[1]!.name).toBe('greet');
    expect(result.sessionId).toBe('test-session');

    // Verify initialize was called first
    expect(mockFetch).toHaveBeenCalledTimes(3);
    const initCall = mockFetch.mock.calls[0]!;
    expect(initCall[0]).toBe('http://localhost:8080/mcp');
    const initBody = JSON.parse(initCall[1]!.body);
    expect(initBody.method).toBe('initialize');
  });

  it('retries on connection errors', async () => {
    // First attempt fails with connection error
    mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));

    // Second attempt succeeds
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Map(),
      text: () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }),
    });
    mockFetch.mockResolvedValueOnce({ ok: true, text: () => '' });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [] } }),
    });

    const result = await listMcpTools(8080);
    expect(result.tools).toEqual([]);
    // 1 failed + 3 successful = 4 total calls
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it('throws ServerError on HTTP error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => 'Internal Server Error',
    });

    await expect(listMcpTools(8080)).rejects.toThrow(ServerError);
  });
});

describe('callMcpTool', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('sends tools/call and returns result text', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () =>
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            content: [{ type: 'text', text: '42' }],
          },
        }),
    });

    const result = await callMcpTool(8080, 'add_numbers', { a: 1, b: 2 });
    expect(result).toBe('42');

    const call = mockFetch.mock.calls[0]!;
    const body = JSON.parse(call[1]!.body);
    expect(body.method).toBe('tools/call');
    expect(body.params.name).toBe('add_numbers');
    expect(body.params.arguments).toEqual({ a: 1, b: 2 });
  });

  it('includes session ID in header when provided', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ text: 'ok' }] } }),
    });

    await callMcpTool(8080, 'test', {}, 'my-session');

    const call = mockFetch.mock.calls[0]!;
    expect(call[1]!.headers['mcp-session-id']).toBe('my-session');
  });

  it('throws on JSON-RPC error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () =>
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          error: { code: -32600, message: 'Invalid tool' },
        }),
    });

    await expect(callMcpTool(8080, 'bad_tool', {})).rejects.toThrow('Invalid tool');
  });
});
