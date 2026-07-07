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

  describe('PrivateLink inbound flags', () => {
    it('accepts a lattice resource-config id', () => {
      expect(
        validateJwtAuthorizerOptions({ ...validBase, privateEndpointLatticeArn: 'rcfg-0123456789abcdefg' })
      ).toEqual({ valid: true });
    });

    it('accepts a full managed-VPC endpoint', () => {
      expect(
        validateJwtAuthorizerOptions({
          ...validBase,
          privateEndpointVpcId: 'vpc-0123456789abcdef0',
          privateEndpointSubnets: 'subnet-0123456789abcdef0, subnet-0fedcba9876543210',
          privateEndpointIpType: 'IPV4',
          privateEndpointSecurityGroups: 'sg-0123456789abcdef0',
          privateEndpointRoutingDomain: 'example.internal',
        })
      ).toEqual({ valid: true });
    });

    it('rejects both lattice + vpc arms (mutually exclusive)', () => {
      const result = validateJwtAuthorizerOptions({
        ...validBase,
        privateEndpointLatticeArn: 'rcfg-0123456789abcdefg',
        privateEndpointVpcId: 'vpc-0123456789abcdef0',
      });
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.error).toContain('mutually exclusive');
    });

    it('rejects managed-VPC missing subnets', () => {
      const result = validateJwtAuthorizerOptions({
        ...validBase,
        privateEndpointVpcId: 'vpc-0123456789abcdef0',
        privateEndpointIpType: 'IPV4',
      });
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.error).toContain('--private-endpoint-subnets is required');
    });

    it('rejects managed-VPC missing ip-type', () => {
      const result = validateJwtAuthorizerOptions({
        ...validBase,
        privateEndpointVpcId: 'vpc-0123456789abcdef0',
        privateEndpointSubnets: 'subnet-0123456789abcdef0',
      });
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.error).toContain('--private-endpoint-ip-type');
    });

    it('rejects an invalid lattice id', () => {
      const result = validateJwtAuthorizerOptions({ ...validBase, privateEndpointLatticeArn: 'nope' });
      expect(result.valid).toBe(false);
    });

    it('rejects VPC sub-flags without --private-endpoint-vpc-id', () => {
      const result = validateJwtAuthorizerOptions({ ...validBase, privateEndpointSubnets: 'subnet-0123456789abcdef0' });
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.error).toContain('require --private-endpoint-vpc-id');
    });

    it('rejects more than 5 overrides', () => {
      const overrides = JSON.stringify(
        Array.from({ length: 6 }, (_, i) => ({
          domain: `d${i}.example.com`,
          privateEndpoint: {
            selfManagedLatticeResource: { resourceConfigurationIdentifier: 'rcfg-0123456789abcdefg' },
          },
        }))
      );
      const result = validateJwtAuthorizerOptions({ ...validBase, privateEndpointOverrides: overrides });
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.error).toContain('at most 5');
    });

    it('rejects malformed overrides JSON', () => {
      const result = validateJwtAuthorizerOptions({ ...validBase, privateEndpointOverrides: '{not json' });
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.error).toContain('must be valid JSON');
    });

    it('accepts valid overrides (with a matching base lattice endpoint)', () => {
      const overrides = JSON.stringify([
        {
          domain: 'api.example.com',
          privateEndpoint: {
            selfManagedLatticeResource: { resourceConfigurationIdentifier: 'rcfg-0123456789abcdefg' },
          },
        },
      ]);
      expect(
        validateJwtAuthorizerOptions({
          ...validBase,
          privateEndpointLatticeArn: 'rcfg-0123456789abcdefg',
          privateEndpointOverrides: overrides,
        })
      ).toEqual({ valid: true });
    });

    it('rejects overrides without a base private endpoint', () => {
      const overrides = JSON.stringify([
        {
          domain: 'api.example.com',
          privateEndpoint: {
            selfManagedLatticeResource: { resourceConfigurationIdentifier: 'rcfg-0123456789abcdefg' },
          },
        },
      ]);
      const result = validateJwtAuthorizerOptions({ ...validBase, privateEndpointOverrides: overrides });
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.error).toContain('requires a base private endpoint');
    });

    it('rejects an override arm that mismatches the base arm (lattice base, vpc override)', () => {
      const overrides = JSON.stringify([
        {
          domain: 'api.example.com',
          privateEndpoint: {
            managedVpcResource: {
              vpcIdentifier: 'vpc-0123456789abcdef0',
              subnetIds: ['subnet-0123456789abcdef0'],
              endpointIpAddressType: 'IPV4',
            },
          },
        },
      ]);
      const result = validateJwtAuthorizerOptions({
        ...validBase,
        privateEndpointLatticeArn: 'rcfg-0123456789abcdefg',
        privateEndpointOverrides: overrides,
      });
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.error).toContain('same kind as the base endpoint');
    });

    it('rejects duplicate override domains', () => {
      const overrides = JSON.stringify([
        {
          domain: 'dup.example.com',
          privateEndpoint: {
            selfManagedLatticeResource: { resourceConfigurationIdentifier: 'rcfg-0123456789abcdefg' },
          },
        },
        {
          domain: 'dup.example.com',
          privateEndpoint: {
            selfManagedLatticeResource: { resourceConfigurationIdentifier: 'rcfg-0123456789abcdefg' },
          },
        },
      ]);
      const result = validateJwtAuthorizerOptions({
        ...validBase,
        privateEndpointLatticeArn: 'rcfg-0123456789abcdefg',
        privateEndpointOverrides: overrides,
      });
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.error).toContain('Duplicate private-endpoint override domain');
    });
  });
});
