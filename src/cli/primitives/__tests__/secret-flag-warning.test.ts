import { warnOnLiteralSecretFlag } from '../secret-flag-warning';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('warnOnLiteralSecretFlag', () => {
  afterEach(() => vi.restoreAllMocks());

  function capture(values: (string | undefined)[], json: boolean | undefined, command = 'add credential'): string {
    let out = '';
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => {
      out += String(chunk);
      return true;
    });
    warnOnLiteralSecretFlag(values, json, command);
    spy.mockRestore();
    return out;
  }

  it('warns when any secret value is provided', () => {
    const out = capture(['sk-123', undefined], false);
    expect(out).toMatch(/passing secrets as CLI flags/i);
    expect(out).toContain('add credential');
  });

  it('does not warn when no secret value is provided', () => {
    expect(capture([undefined, undefined], false)).toBe('');
  });

  it('is suppressed under --json', () => {
    expect(capture(['sk-123'], true)).toBe('');
  });

  it('uses the given command name in the suggestion', () => {
    expect(capture(['s'], false, 'add payment-connector')).toContain('add payment-connector');
  });
});
