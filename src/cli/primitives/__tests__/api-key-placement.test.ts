import { buildApiKeyPlacement } from '../api-key-placement';
import { describe, expect, it } from 'vitest';

describe('buildApiKeyPlacement', () => {
  it('returns undefined when no fields are set', () => {
    expect(buildApiKeyPlacement({})).toBeUndefined();
  });

  it('returns undefined when fields equal the defaults (HEADER / x-api-key, no prefix)', () => {
    expect(buildApiKeyPlacement({ location: 'HEADER', parameterName: 'x-api-key' })).toBeUndefined();
  });

  it('builds a block when location differs', () => {
    expect(buildApiKeyPlacement({ location: 'QUERY_PARAMETER' })).toEqual({ location: 'QUERY_PARAMETER' });
  });

  it('builds a block with a custom parameter name and prefix', () => {
    expect(buildApiKeyPlacement({ parameterName: 'Authorization', prefix: 'Bearer' })).toEqual({
      parameterName: 'Authorization',
      prefix: 'Bearer',
    });
  });

  it('omits fields that are undefined', () => {
    expect(buildApiKeyPlacement({ prefix: 'Bearer' })).toEqual({ prefix: 'Bearer' });
  });

  it('omits a parameterName equal to the default but keeps a non-default location', () => {
    expect(buildApiKeyPlacement({ location: 'QUERY_PARAMETER', parameterName: 'x-api-key' })).toEqual({
      location: 'QUERY_PARAMETER',
    });
  });
});
