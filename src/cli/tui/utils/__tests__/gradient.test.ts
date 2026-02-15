import { createGradient } from '../gradient.js';
import { describe, expect, it } from 'vitest';

describe('createGradient', () => {
  it('returns a string containing the original characters', () => {
    const result = createGradient('Hello');
    // Strip ANSI escape codes to verify original text
    // eslint-disable-next-line no-control-regex
    const stripped = result.replace(/\x1b\[[0-9;]*m/g, '');
    expect(stripped).toBe('Hello');
  });

  it('wraps each character with ANSI color codes', () => {
    const result = createGradient('AB');
    // Should contain escape sequences
    expect(result).toContain('\x1b[');
    // Should contain the reset code
    expect(result).toContain('\x1b[0m');
  });

  it('handles empty string', () => {
    expect(createGradient('')).toBe('');
  });

  it('handles single character', () => {
    const result = createGradient('X');
    // eslint-disable-next-line no-control-regex
    const stripped = result.replace(/\x1b\[[0-9;]*m/g, '');
    expect(stripped).toBe('X');
  });

  it('produces different colors for characters at different positions', () => {
    // With a long enough string, we should see multiple different color codes
    const result = createGradient('ABCDEFGHIJKLMNOP');
    // Count distinct escape sequences (excluding reset)
    // eslint-disable-next-line no-control-regex
    const codes = result.match(/\x1b\[(?!0m)[0-9;]*m/g) ?? [];
    const unique = new Set(codes);
    expect(unique.size).toBeGreaterThan(1);
  });
});
