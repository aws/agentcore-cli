import {
  CustomJwtAuthorizerConfigSchema,
  ManagedVpcResourceSchema,
  PrivateEndpointOverrideSchema,
  PrivateEndpointSchema,
  SelfManagedLatticeResourceSchema,
} from '../auth';
import { describe, expect, it } from 'vitest';

const RCFG = 'rcfg-0123456789abcdefg';
const RCFG_ARN = 'arn:aws:vpc-lattice:us-west-2:123456789012:resourceconfiguration/rcfg-0123456789abcdefg';

describe('SelfManagedLatticeResourceSchema', () => {
  it('accepts an rcfg id', () => {
    expect(SelfManagedLatticeResourceSchema.safeParse({ resourceConfigurationIdentifier: RCFG }).success).toBe(true);
  });
  it('accepts a full VPC Lattice ARN', () => {
    expect(SelfManagedLatticeResourceSchema.safeParse({ resourceConfigurationIdentifier: RCFG_ARN }).success).toBe(
      true
    );
  });
  it('rejects a malformed identifier', () => {
    expect(SelfManagedLatticeResourceSchema.safeParse({ resourceConfigurationIdentifier: 'nope' }).success).toBe(false);
  });
});

describe('ManagedVpcResourceSchema', () => {
  const valid = {
    vpcIdentifier: 'vpc-0123456789abcdef0',
    subnetIds: ['subnet-0123456789abcdef0'],
    endpointIpAddressType: 'IPV4' as const,
  };

  it('accepts required-only', () => {
    expect(ManagedVpcResourceSchema.safeParse(valid).success).toBe(true);
  });
  it('accepts optional securityGroupIds/tags/routingDomain', () => {
    expect(
      ManagedVpcResourceSchema.safeParse({
        ...valid,
        securityGroupIds: ['sg-0123456789abcdef0', 'sg-0fedcba9876543210'],
        tags: { team: 'agentcore' },
        routingDomain: 'example.internal',
      }).success
    ).toBe(true);
  });
  it('rejects missing vpcIdentifier', () => {
    const { vpcIdentifier, ...rest } = valid;
    void vpcIdentifier;
    expect(ManagedVpcResourceSchema.safeParse(rest).success).toBe(false);
  });
  it('rejects an empty subnetIds array', () => {
    expect(ManagedVpcResourceSchema.safeParse({ ...valid, subnetIds: [] }).success).toBe(false);
  });
  it('rejects a bad subnet id', () => {
    expect(ManagedVpcResourceSchema.safeParse({ ...valid, subnetIds: ['nope'] }).success).toBe(false);
  });
  it('rejects an invalid endpointIpAddressType', () => {
    expect(ManagedVpcResourceSchema.safeParse({ ...valid, endpointIpAddressType: 'ipv4' }).success).toBe(false);
  });
  it('rejects more than 5 securityGroupIds', () => {
    const sgs = Array.from({ length: 6 }, (_, i) => `sg-0123456789abcde${i}0`);
    expect(ManagedVpcResourceSchema.safeParse({ ...valid, securityGroupIds: sgs }).success).toBe(false);
  });
  it('rejects a bad security group id', () => {
    expect(ManagedVpcResourceSchema.safeParse({ ...valid, securityGroupIds: ['nope'] }).success).toBe(false);
  });
});

describe('PrivateEndpointSchema (exactly-one-of)', () => {
  it('accepts the lattice arm alone', () => {
    expect(
      PrivateEndpointSchema.safeParse({ selfManagedLatticeResource: { resourceConfigurationIdentifier: RCFG } }).success
    ).toBe(true);
  });
  it('accepts the managed-vpc arm alone', () => {
    expect(
      PrivateEndpointSchema.safeParse({
        managedVpcResource: {
          vpcIdentifier: 'vpc-0123456789abcdef0',
          subnetIds: ['subnet-0123456789abcdef0'],
          endpointIpAddressType: 'IPV4',
        },
      }).success
    ).toBe(true);
  });
  it('rejects BOTH arms present', () => {
    const result = PrivateEndpointSchema.safeParse({
      selfManagedLatticeResource: { resourceConfigurationIdentifier: RCFG },
      managedVpcResource: {
        vpcIdentifier: 'vpc-0123456789abcdef0',
        subnetIds: ['subnet-0123456789abcdef0'],
        endpointIpAddressType: 'IPV4',
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.message.includes('exactly one'))).toBe(true);
    }
  });
  it('rejects NEITHER arm present (empty object)', () => {
    expect(PrivateEndpointSchema.safeParse({}).success).toBe(false);
  });
});

describe('PrivateEndpointOverrideSchema', () => {
  it('accepts a domain + nested private endpoint', () => {
    expect(
      PrivateEndpointOverrideSchema.safeParse({
        domain: 'api.example.com',
        privateEndpoint: { selfManagedLatticeResource: { resourceConfigurationIdentifier: RCFG } },
      }).success
    ).toBe(true);
  });
  it('rejects a missing domain', () => {
    expect(
      PrivateEndpointOverrideSchema.safeParse({
        privateEndpoint: { selfManagedLatticeResource: { resourceConfigurationIdentifier: RCFG } },
      }).success
    ).toBe(false);
  });
});

describe('CustomJwtAuthorizerConfigSchema with PrivateLink fields', () => {
  const base = {
    discoveryUrl: 'https://idp.example.com/.well-known/openid-configuration',
    allowedAudience: ['aud-1'],
  };

  it('accepts a privateEndpoint', () => {
    expect(
      CustomJwtAuthorizerConfigSchema.safeParse({
        ...base,
        privateEndpoint: { selfManagedLatticeResource: { resourceConfigurationIdentifier: RCFG } },
      }).success
    ).toBe(true);
  });
  const latticeEndpoint = { selfManagedLatticeResource: { resourceConfigurationIdentifier: RCFG } };
  const vpcEndpoint = {
    managedVpcResource: {
      vpcIdentifier: 'vpc-0123456789abcdef0',
      subnetIds: ['subnet-0123456789abcdef0'],
      endpointIpAddressType: 'IPV4' as const,
    },
  };

  it('accepts up to 5 privateEndpointOverrides (with a base privateEndpoint)', () => {
    const overrides = Array.from({ length: 5 }, (_, i) => ({
      domain: `d${i}.example.com`,
      privateEndpoint: latticeEndpoint,
    }));
    expect(
      CustomJwtAuthorizerConfigSchema.safeParse({
        ...base,
        privateEndpoint: latticeEndpoint,
        privateEndpointOverrides: overrides,
      }).success
    ).toBe(true);
  });
  it('rejects more than 5 privateEndpointOverrides', () => {
    const overrides = Array.from({ length: 6 }, (_, i) => ({
      domain: `d${i}.example.com`,
      privateEndpoint: latticeEndpoint,
    }));
    expect(
      CustomJwtAuthorizerConfigSchema.safeParse({
        ...base,
        privateEndpoint: latticeEndpoint,
        privateEndpointOverrides: overrides,
      }).success
    ).toBe(false);
  });
  it('still accepts a config with no PrivateLink fields (backwards compat)', () => {
    expect(CustomJwtAuthorizerConfigSchema.safeParse(base).success).toBe(true);
  });

  // ── PrivateEndpointOverrides coupling rules (mirror the AgentCore Identity service) ──
  it('rejects privateEndpointOverrides without a base privateEndpoint', () => {
    const result = CustomJwtAuthorizerConfigSchema.safeParse({
      ...base,
      privateEndpointOverrides: [{ domain: 'd.example.com', privateEndpoint: latticeEndpoint }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.message.includes('only be used when privateEndpoint is also set'))).toBe(
        true
      );
    }
  });
  it('rejects an override arm that mismatches the base arm (lattice base, vpc override)', () => {
    const result = CustomJwtAuthorizerConfigSchema.safeParse({
      ...base,
      privateEndpoint: latticeEndpoint,
      privateEndpointOverrides: [{ domain: 'd.example.com', privateEndpoint: vpcEndpoint }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.message.includes('same kind'))).toBe(true);
    }
  });
  it('rejects an override arm that mismatches the base arm (vpc base, lattice override)', () => {
    const result = CustomJwtAuthorizerConfigSchema.safeParse({
      ...base,
      privateEndpoint: vpcEndpoint,
      privateEndpointOverrides: [{ domain: 'd.example.com', privateEndpoint: latticeEndpoint }],
    });
    expect(result.success).toBe(false);
  });
  it('accepts all-managed-vpc base + overrides', () => {
    expect(
      CustomJwtAuthorizerConfigSchema.safeParse({
        ...base,
        privateEndpoint: vpcEndpoint,
        privateEndpointOverrides: [{ domain: 'd.example.com', privateEndpoint: vpcEndpoint }],
      }).success
    ).toBe(true);
  });
  it('rejects duplicate override domains', () => {
    const result = CustomJwtAuthorizerConfigSchema.safeParse({
      ...base,
      privateEndpoint: latticeEndpoint,
      privateEndpointOverrides: [
        { domain: 'dup.example.com', privateEndpoint: latticeEndpoint },
        { domain: 'dup.example.com', privateEndpoint: latticeEndpoint },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.message.includes('Duplicate privateEndpointOverride domain'))).toBe(true);
    }
  });
});
