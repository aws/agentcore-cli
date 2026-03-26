import { parseAndValidateLifecycleOptions } from '../lifecycle-utils';
import { describe, expect, it } from 'vitest';

describe('parseAndValidateLifecycleOptions', () => {
  it('returns valid when no options are set', () => {
    expect(parseAndValidateLifecycleOptions({})).toEqual({ valid: true });
  });

  it('accepts valid idleTimeout and returns parsed value', () => {
    const result = parseAndValidateLifecycleOptions({ idleTimeout: 900 });
    expect(result).toEqual({ valid: true, idleTimeout: 900 });
  });

  it('accepts valid maxLifetime and returns parsed value', () => {
    const result = parseAndValidateLifecycleOptions({ maxLifetime: 3600 });
    expect(result).toEqual({ valid: true, maxLifetime: 3600 });
  });

  it('accepts both when idle <= max', () => {
    const result = parseAndValidateLifecycleOptions({ idleTimeout: 600, maxLifetime: 3600 });
    expect(result).toEqual({ valid: true, idleTimeout: 600, maxLifetime: 3600 });
  });

  it('accepts boundary values (60 and 28800)', () => {
    const result = parseAndValidateLifecycleOptions({ idleTimeout: 60, maxLifetime: 28800 });
    expect(result).toEqual({ valid: true, idleTimeout: 60, maxLifetime: 28800 });
  });

  it('accepts equal values', () => {
    const result = parseAndValidateLifecycleOptions({ idleTimeout: 3600, maxLifetime: 3600 });
    expect(result).toEqual({ valid: true, idleTimeout: 3600, maxLifetime: 3600 });
  });

  it('rejects idleTimeout below 60', () => {
    const result = parseAndValidateLifecycleOptions({ idleTimeout: 59 });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('--idle-timeout');
  });

  it('rejects idleTimeout above 28800', () => {
    const result = parseAndValidateLifecycleOptions({ idleTimeout: 28801 });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('--idle-timeout');
  });

  it('rejects maxLifetime below 60', () => {
    const result = parseAndValidateLifecycleOptions({ maxLifetime: 59 });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('--max-lifetime');
  });

  it('rejects maxLifetime above 28800', () => {
    const result = parseAndValidateLifecycleOptions({ maxLifetime: 28801 });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('--max-lifetime');
  });

  it('rejects idle > max', () => {
    const result = parseAndValidateLifecycleOptions({ idleTimeout: 5000, maxLifetime: 3000 });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('--idle-timeout must be <= --max-lifetime');
  });

  it('rejects non-integer idleTimeout', () => {
    const result = parseAndValidateLifecycleOptions({ idleTimeout: 120.5 });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('--idle-timeout');
  });

  it('rejects NaN string idleTimeout', () => {
    const result = parseAndValidateLifecycleOptions({ idleTimeout: 'abc' });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('--idle-timeout');
  });

  it('rejects NaN string maxLifetime', () => {
    const result = parseAndValidateLifecycleOptions({ maxLifetime: 'abc' });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('--max-lifetime');
  });

  it('parses string values to numbers without mutating input', () => {
    const opts = { idleTimeout: '300', maxLifetime: '7200' };
    const result = parseAndValidateLifecycleOptions(opts);
    expect(result.valid).toBe(true);
    expect(result.idleTimeout).toBe(300);
    expect(result.maxLifetime).toBe(7200);
    // Original input is NOT mutated
    expect(opts.idleTimeout).toBe('300');
    expect(opts.maxLifetime).toBe('7200');
  });
});
