import { validateDeployOptions } from '../validate.js';
import { describe, expect, it } from 'vitest';

describe('validateDeployOptions', () => {
  it('always returns valid', () => {
    expect(validateDeployOptions({})).toEqual({ valid: true });
  });

  it('returns valid with all options set', () => {
    expect(validateDeployOptions({ target: 'prod', yes: true, verbose: true, json: true })).toEqual({ valid: true });
  });

  it('returns valid with target only', () => {
    expect(validateDeployOptions({ target: 'default' })).toEqual({ valid: true });
  });
});
