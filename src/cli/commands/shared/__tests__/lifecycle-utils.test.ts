import { validateLifecycleOptions } from '../lifecycle-utils';
import { describe, expect, it } from 'vitest';

describe('validateLifecycleOptions', () => {
  it('returns valid when no options are set', () => {
    expect(validateLifecycleOptions({})).toEqual({ valid: true });
  });

  it('accepts valid idleTimeout', () => {
    const opts = { idleTimeout: 900 };
    expect(validateLifecycleOptions(opts)).toEqual({ valid: true });
    expect(opts.idleTimeout).toBe(900);
  });

  it('accepts valid maxLifetime', () => {
    const opts = { maxLifetime: 3600 };
    expect(validateLifecycleOptions(opts)).toEqual({ valid: true });
    expect(opts.maxLifetime).toBe(3600);
  });

  it('accepts both when idle <= max', () => {
    expect(validateLifecycleOptions({ idleTimeout: 600, maxLifetime: 3600 })).toEqual({ valid: true });
  });

  it('accepts boundary values (60 and 28800)', () => {
    expect(validateLifecycleOptions({ idleTimeout: 60, maxLifetime: 28800 })).toEqual({ valid: true });
  });

  it('accepts equal values', () => {
    expect(validateLifecycleOptions({ idleTimeout: 3600, maxLifetime: 3600 })).toEqual({ valid: true });
  });

  it('rejects idleTimeout below 60', () => {
    const result = validateLifecycleOptions({ idleTimeout: 59 });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('--idle-timeout');
  });

  it('rejects idleTimeout above 28800', () => {
    const result = validateLifecycleOptions({ idleTimeout: 28801 });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('--idle-timeout');
  });

  it('rejects maxLifetime below 60', () => {
    const result = validateLifecycleOptions({ maxLifetime: 59 });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('--max-lifetime');
  });

  it('rejects maxLifetime above 28800', () => {
    const result = validateLifecycleOptions({ maxLifetime: 28801 });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('--max-lifetime');
  });

  it('rejects idle > max', () => {
    const result = validateLifecycleOptions({ idleTimeout: 5000, maxLifetime: 3000 });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('--idle-timeout must be <= --max-lifetime');
  });

  it('rejects non-integer idleTimeout', () => {
    const result = validateLifecycleOptions({ idleTimeout: 120.5 });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('--idle-timeout');
  });

  it('rejects NaN string idleTimeout', () => {
    const result = validateLifecycleOptions({ idleTimeout: 'abc' as unknown as number });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('--idle-timeout');
  });

  it('rejects NaN string maxLifetime', () => {
    const result = validateLifecycleOptions({ maxLifetime: 'abc' as unknown as number });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('--max-lifetime');
  });

  it('normalizes string values to numbers', () => {
    const opts: { idleTimeout?: number | string; maxLifetime?: number | string } = {
      idleTimeout: '300',
      maxLifetime: '7200',
    };
    const result = validateLifecycleOptions(opts);
    expect(result.valid).toBe(true);
    expect(opts.idleTimeout).toBe(300);
    expect(opts.maxLifetime).toBe(7200);
  });
});
