import { validateLookbackDays } from '../handler.js';
import { describe, expect, it } from 'vitest';

describe('validateLookbackDays', () => {
  it('accepts positive integers', () => {
    expect(() => validateLookbackDays(1)).not.toThrow();
    expect(() => validateLookbackDays(7)).not.toThrow();
    expect(() => validateLookbackDays(30)).not.toThrow();
  });

  it('rejects negative values', () => {
    expect(() => validateLookbackDays(-5)).toThrow('positive integer');
    expect(() => validateLookbackDays(-1)).toThrow('positive integer');
  });

  it('rejects zero', () => {
    expect(() => validateLookbackDays(0)).toThrow('positive integer');
  });

  it('rejects non-integer values', () => {
    expect(() => validateLookbackDays(2.5)).toThrow('positive integer');
    expect(() => validateLookbackDays(0.5)).toThrow('positive integer');
  });
});
