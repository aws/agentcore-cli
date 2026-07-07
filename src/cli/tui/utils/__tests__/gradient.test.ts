import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('createGradient', () => {
  let originalForceColor: string | undefined;

  beforeAll(() => {
    originalForceColor = process.env.FORCE_COLOR;
    process.env.FORCE_COLOR = '1';
  });

  afterAll(() => {
    if (originalForceColor === undefined) {
      delete process.env.FORCE_COLOR;
    } else {
      process.env.FORCE_COLOR = originalForceColor;
    }
  });

  it('wraps each character with ANSI color codes', async () => {
    const { createGradient } = await import('../gradient.js');
    const result = createGradient('AB');
    expect(result).toContain('\x1b[');
    expect(result).toContain('\x1b[0m');
  });

  it('handles empty string', async () => {
    const { createGradient } = await import('../gradient.js');
    expect(createGradient('')).toBe('');
  });

  it('handles single character', async () => {
    const { createGradient } = await import('../gradient.js');
    const result = createGradient('X');
    // eslint-disable-next-line no-control-regex
    const stripped = result.replace(/\x1b\[[0-9;]*m/g, '');
    expect(stripped).toBe('X');
  });

  it('produces different colors for characters at different positions', async () => {
    const { createGradient } = await import('../gradient.js');
    const result = createGradient('ABCDEFGHIJKLMNOP');
    // eslint-disable-next-line no-control-regex
    const codes = result.match(/\x1b\[(?!0m)[0-9;]*m/g) ?? [];
    const unique = new Set(codes);
    expect(unique.size).toBeGreaterThan(1);
  });
});
