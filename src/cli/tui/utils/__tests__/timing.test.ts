import { withMinDuration } from '../timing.js';
import { describe, expect, it } from 'vitest';

describe('withMinDuration', () => {
  it('returns the result of the wrapped function', async () => {
    const result = await withMinDuration(() => Promise.resolve(42));
    expect(result).toBe(42);
  });

  it('takes at least ~200ms even if function resolves instantly', async () => {
    const start = Date.now();
    await withMinDuration(() => Promise.resolve('fast'));
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(180); // small tolerance
  });

  it('does not add extra delay for slow functions', async () => {
    const start = Date.now();
    await withMinDuration(async () => {
      await new Promise(resolve => setTimeout(resolve, 300));
      return 'slow';
    });
    const elapsed = Date.now() - start;
    // Should be ~300ms, not 300+200
    expect(elapsed).toBeLessThan(550);
  });

  it('propagates errors from the wrapped function', async () => {
    await expect(
      withMinDuration(() => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
  });
});
