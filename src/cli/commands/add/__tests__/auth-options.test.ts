import { validateJwtAuthorizerOptions } from '../auth-options';
import { describe, expect, it } from 'vitest';

describe('validateJwtAuthorizerOptions', () => {
  const validBase = {
    discoveryUrl: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_abc123/.well-known/openid-configuration',
    allowedAudience: 'aud1',
  };

  it('accepts valid options with audience', () => {
    expect(validateJwtAuthorizerOptions(validBase)).toEqual({ valid: true });
  });

  it('accepts valid options with clients', () => {
    expect(
      validateJwtAuthorizerOptions({ ...validBase, allowedAudience: undefined, allowedClients: 'client1' })
    ).toEqual({ valid: true });
  });

  it('accepts valid options with scopes', () => {
    expect(validateJwtAuthorizerOptions({ ...validBase, allowedAudience: undefined, allowedScopes: 'scope1' })).toEqual(
      { valid: true }
    );
  });

  it('accepts valid options with custom claims', () => {
    const claims = JSON.stringify([
      {
        inboundTokenClaimName: 'dept',
        inboundTokenClaimValueType: 'STRING',
        authorizingClaimMatchValue: {
          claimMatchOperator: 'EQUALS',
          claimMatchValue: { matchValueString: 'eng' },
        },
      },
    ]);
    expect(validateJwtAuthorizerOptions({ ...validBase, allowedAudience: undefined, customClaims: claims })).toEqual({
      valid: true,
    });
  });

  it('rejects missing discovery URL', () => {
    const result = validateJwtAuthorizerOptions({ allowedAudience: 'aud1' });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('--discovery-url is required');
  });

  it('rejects non-HTTPS discovery URL', () => {
    const result = validateJwtAuthorizerOptions({
      discoveryUrl: 'http://example.com/.well-known/openid-configuration',
      allowedAudience: 'aud1',
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('HTTPS');
  });

  it('rejects discovery URL without well-known suffix', () => {
    const result = validateJwtAuthorizerOptions({
      discoveryUrl: 'https://example.com/auth',
      allowedAudience: 'aud1',
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('.well-known/openid-configuration');
  });

  it('rejects invalid discovery URL', () => {
    const result = validateJwtAuthorizerOptions({
      discoveryUrl: 'not-a-url',
      allowedAudience: 'aud1',
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('valid URL');
  });

  it('requires at least one constraint', () => {
    const result = validateJwtAuthorizerOptions({
      discoveryUrl: 'https://example.com/.well-known/openid-configuration',
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('At least one of');
  });

  it('rejects invalid custom claims JSON', () => {
    const result = validateJwtAuthorizerOptions({
      ...validBase,
      customClaims: 'not-json',
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('valid JSON');
  });

  it('rejects empty custom claims array', () => {
    const result = validateJwtAuthorizerOptions({
      ...validBase,
      customClaims: '[]',
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('non-empty JSON array');
  });

  it('rejects clientId without clientSecret', () => {
    const result = validateJwtAuthorizerOptions({ ...validBase, clientId: 'id' });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('--client-id and --client-secret must be provided together');
  });

  it('rejects clientSecret without clientId', () => {
    const result = validateJwtAuthorizerOptions({ ...validBase, clientSecret: 'secret' });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('--client-id and --client-secret must be provided together');
  });

  it('accepts client credentials pair', () => {
    expect(validateJwtAuthorizerOptions({ ...validBase, clientId: 'id', clientSecret: 'secret' })).toEqual({
      valid: true,
    });
  });
});
