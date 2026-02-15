import { validateRemoveAllOptions, validateRemoveOptions } from '../validate.js';
import { describe, expect, it } from 'vitest';

describe('validateRemoveOptions', () => {
  it('returns valid when json is false', () => {
    expect(validateRemoveOptions({ resourceType: 'agent', json: false })).toEqual({ valid: true });
  });

  it('returns valid when json is true and name is provided', () => {
    expect(validateRemoveOptions({ resourceType: 'agent', json: true, name: 'my-agent' })).toEqual({ valid: true });
  });

  it('returns invalid when json is true but no name', () => {
    const result = validateRemoveOptions({ resourceType: 'agent', json: true });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('--name is required for JSON output');
  });

  it('returns valid with name but no json', () => {
    expect(validateRemoveOptions({ resourceType: 'memory', name: 'mem1' })).toEqual({ valid: true });
  });

  it('returns valid with no json and no name', () => {
    expect(validateRemoveOptions({ resourceType: 'identity' })).toEqual({ valid: true });
  });
});

describe('validateRemoveAllOptions', () => {
  it('always returns valid', () => {
    expect(validateRemoveAllOptions({})).toEqual({ valid: true });
  });

  it('returns valid with all options', () => {
    expect(validateRemoveAllOptions({ force: true, dryRun: true, json: true })).toEqual({ valid: true });
  });
});
