import { formatError } from '../preflight.js';
import { describe, expect, it } from 'vitest';

describe('formatError', () => {
  it('formats Error with message only', () => {
    const err = new Error('something failed');
    err.stack = undefined;

    expect(formatError(err)).toBe('something failed');
  });

  it('includes stack trace when available', () => {
    const err = new Error('with stack');

    const result = formatError(err);

    expect(result).toContain('with stack');
    expect(result).toContain('Stack trace:');
  });

  it('formats nested cause', () => {
    const cause = new Error('root cause');
    cause.stack = undefined;
    const err = new Error('outer error', { cause });
    err.stack = undefined;

    const result = formatError(err);

    expect(result).toContain('outer error');
    expect(result).toContain('Caused by:');
    expect(result).toContain('root cause');
  });

  it('formats non-Error values as string', () => {
    expect(formatError('string error')).toBe('string error');
    expect(formatError(42)).toBe('42');
    expect(formatError(null)).toBe('null');
  });
});
