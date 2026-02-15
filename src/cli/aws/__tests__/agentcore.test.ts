import { extractResult, parseSSE, parseSSELine } from '../agentcore.js';
import { describe, expect, it } from 'vitest';

describe('parseSSELine', () => {
  it('returns null content for non-data lines', () => {
    expect(parseSSELine('event: message')).toEqual({ content: null, error: null });
    expect(parseSSELine('')).toEqual({ content: null, error: null });
    expect(parseSSELine('id: 123')).toEqual({ content: null, error: null });
  });

  it('parses JSON string data', () => {
    const result = parseSSELine('data: "Hello world"');
    expect(result.content).toBe('Hello world');
    expect(result.error).toBeNull();
  });

  it('returns raw content for non-JSON data', () => {
    const result = parseSSELine('data: plain text here');
    expect(result.content).toBe('plain text here');
    expect(result.error).toBeNull();
  });

  it('detects error objects', () => {
    const result = parseSSELine('data: {"error": "Something went wrong"}');
    expect(result.content).toBeNull();
    expect(result.error).toBe('Something went wrong');
  });

  it('returns null for non-string non-error JSON objects', () => {
    const result = parseSSELine('data: {"key": "value"}');
    expect(result.content).toBeNull();
    expect(result.error).toBeNull();
  });

  it('handles empty data field', () => {
    const result = parseSSELine('data: ');
    expect(result.content).toBe('');
    expect(result.error).toBeNull();
  });
});

describe('parseSSE', () => {
  it('combines multiple data lines into single string', () => {
    const text = 'data: "Hello "\ndata: "World"';
    expect(parseSSE(text)).toBe('Hello World');
  });

  it('ignores non-data lines', () => {
    const text = 'event: message\ndata: "content"\nid: 1';
    expect(parseSSE(text)).toBe('content');
  });

  it('returns empty string for no data lines', () => {
    expect(parseSSE('event: ping\n')).toBe('');
  });

  it('stops on error and returns error message', () => {
    const text = 'data: "part1"\ndata: {"error": "fail"}\ndata: "part2"';
    expect(parseSSE(text)).toBe('Error: fail');
  });

  it('handles single data line', () => {
    expect(parseSSE('data: "only line"')).toBe('only line');
  });

  it('handles raw non-JSON data lines', () => {
    const text = 'data: hello\ndata: world';
    expect(parseSSE(text)).toBe('helloworld');
  });
});

describe('extractResult', () => {
  it('extracts string result from JSON object', () => {
    expect(extractResult('{"result": "answer"}')).toBe('answer');
  });

  it('stringifies non-string result', () => {
    const result = extractResult('{"result": {"key": "val"}}');
    expect(result).toContain('key');
    expect(result).toContain('val');
  });

  it('returns plain string from JSON string', () => {
    expect(extractResult('"plain string"')).toBe('plain string');
  });

  it('stringifies JSON object without result field', () => {
    const result = extractResult('{"data": 42}');
    expect(result).toContain('42');
  });

  it('returns raw text for non-JSON input', () => {
    expect(extractResult('not json at all')).toBe('not json at all');
  });

  it('handles empty string', () => {
    expect(extractResult('')).toBe('');
  });
});
