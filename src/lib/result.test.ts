import { serializeResult } from './result';
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
