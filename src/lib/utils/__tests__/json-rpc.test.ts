import { parseJsonRpcResponse } from '../json-rpc';
import { describe, expect, it } from 'vitest';

describe('parseJsonRpcResponse', () => {
  it('parses plain JSON response', () => {
    const result = parseJsonRpcResponse('{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}');
    expect(result).toEqual({ jsonrpc: '2.0', id: 1, result: { tools: [] } });
  });

  it('parses SSE-wrapped JSON-RPC response', () => {
    const result = parseJsonRpcResponse('data: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}');
    expect(result).toEqual({ jsonrpc: '2.0', id: 1, result: { ok: true } });
  });

  it('uses last valid SSE data line', () => {
    const text = 'data: {"partial":true}\ndata: {"jsonrpc":"2.0","id":1,"result":{}}';
    const result = parseJsonRpcResponse(text);
    expect(result).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
  });

  it('handles whitespace around response', () => {
    const result = parseJsonRpcResponse('  {"result": "ok"}  \n');
    expect(result).toEqual({ result: 'ok' });
  });

  it('parses JSON-RPC error response', () => {
    const result = parseJsonRpcResponse('{"jsonrpc":"2.0","id":1,"error":{"code":-32600,"message":"Bad request"}}');
    expect(result.error).toEqual({ code: -32600, message: 'Bad request' });
  });

  it('throws on HTML error page', () => {
    expect(() => parseJsonRpcResponse('<html><body>500 Error</body></html>')).toThrow(
      'Failed to parse JSON-RPC response'
    );
  });

  it('throws on empty string', () => {
    expect(() => parseJsonRpcResponse('')).toThrow('Failed to parse JSON-RPC response');
  });

  it('throws on non-JSON non-SSE text', () => {
    expect(() => parseJsonRpcResponse('this is not json or sse')).toThrow('Failed to parse JSON-RPC response');
  });

  it('truncates long text in error message', () => {
    const longText = 'x'.repeat(300);
    expect(() => parseJsonRpcResponse(longText)).toThrow(/x{200}/);
  });
});
