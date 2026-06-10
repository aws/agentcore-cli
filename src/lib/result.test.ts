import { serializeResult, unwrapResult } from './result';
import type { Result } from './result';
import { describe, expect, it } from 'vitest';

describe('serializeResult', () => {
  it('passes through success results unchanged', () => {
    const result = { success: true as const, name: 'test' };
    expect(serializeResult(result)).toEqual({ success: true, name: 'test' });
  });

  it('converts error.message to string on failure', () => {
    const result = { success: false as const, error: new Error('something broke') };
    expect(serializeResult(result)).toEqual({ success: false, error: 'something broke' });
  });

  it('preserves extra fields on failure branch', () => {
    const result = { success: false as const, error: new Error('fail'), logPath: '/tmp/log' };
    expect(serializeResult(result)).toEqual({ success: false, error: 'fail', logPath: '/tmp/log' });
  });
});

describe('unwrapResult', () => {
  it('returns the data portion (without success) on success', () => {
    const result: Result<{ name: string; count: number }> = { success: true, name: 'a', count: 3 };

    expect(unwrapResult(result)).toEqual({ name: 'a', count: 3 });
  });

  it('returns an empty object when the success branch has no payload', () => {
    const result: Result = { success: true };

    expect(unwrapResult(result)).toEqual({});
  });

  it('throws the contained error on failure when no default is provided', () => {
    const error = new Error('boom');
    const result: Result<{ name: string }> = { success: false, error };

    expect(() => unwrapResult(result)).toThrow(error);
  });

  it('returns the provided default on failure', () => {
    const result = { success: false, error: new Error('boom') } as Result<{ name: string }>;

    expect(unwrapResult(result, { name: 'fallback' })).toEqual({ name: 'fallback' });
  });
});
