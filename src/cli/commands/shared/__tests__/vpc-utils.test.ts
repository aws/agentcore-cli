import {
  parseCommaSeparatedList,
  resolveVpcIdFromSubnets,
  validateSecurityGroupIds,
  validateSubnetIds,
  validateVpcId,
  validateVpcOptions,
} from '../vpc-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock('@aws-sdk/client-ec2', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-ec2')>('@aws-sdk/client-ec2');
  return {
    ...actual,
    EC2Client: class {
      send = mockSend;
    },
  };
});

vi.mock('../../../aws/account', () => ({ getCredentialProvider: () => undefined }));

describe('parseCommaSeparatedList', () => {
  it('returns undefined for undefined input', () => {
    expect(parseCommaSeparatedList(undefined)).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(parseCommaSeparatedList('')).toBeUndefined();
  });

  it('parses comma-separated values and trims whitespace', () => {
    expect(parseCommaSeparatedList('a, b , c')).toEqual(['a', 'b', 'c']);
  });

  it('filters out empty entries from trailing commas', () => {
    expect(parseCommaSeparatedList('a,,b,')).toEqual(['a', 'b']);
  });

  it('handles a single value', () => {
    expect(parseCommaSeparatedList('subnet-12345678')).toEqual(['subnet-12345678']);
  });
});

describe('validateSubnetIds', () => {
  it('accepts valid subnet IDs', () => {
    expect(validateSubnetIds('subnet-12345678')).toBe(true);
    expect(validateSubnetIds('subnet-12345678, subnet-abcdef12')).toBe(true);
    expect(validateSubnetIds('subnet-0123456789abcdef0')).toBe(true);
  });

  it('rejects empty input', () => {
    const result = validateSubnetIds('');
    expect(result).not.toBe(true);
    expect(result).toContain('At least one subnet ID is required');
  });

  it('rejects invalid subnet ID format', () => {
    const result = validateSubnetIds('vpc-12345678');
    expect(result).not.toBe(true);
    expect(result).toContain('Invalid subnet ID format');
  });

  it('rejects if any ID in the list is invalid', () => {
    const result = validateSubnetIds('subnet-12345678, bad-id');
    expect(result).not.toBe(true);
    expect(result).toContain('Invalid subnet ID format');
  });

  it('rejects subnet IDs that are too short', () => {
    const result = validateSubnetIds('subnet-1234');
    expect(result).not.toBe(true);
  });
});

describe('validateSecurityGroupIds', () => {
  it('accepts valid security group IDs', () => {
    expect(validateSecurityGroupIds('sg-12345678')).toBe(true);
    expect(validateSecurityGroupIds('sg-12345678, sg-abcdef12')).toBe(true);
    expect(validateSecurityGroupIds('sg-0123456789abcdef0')).toBe(true);
  });

  it('rejects empty input', () => {
    const result = validateSecurityGroupIds('');
    expect(result).not.toBe(true);
    expect(result).toContain('At least one security group ID is required');
  });

  it('rejects invalid security group ID format', () => {
    const result = validateSecurityGroupIds('subnet-12345678');
    expect(result).not.toBe(true);
    expect(result).toContain('Invalid security group ID format');
  });

  it('rejects if any ID in the list is invalid', () => {
    const result = validateSecurityGroupIds('sg-12345678, bad-id');
    expect(result).not.toBe(true);
    expect(result).toContain('Invalid security group ID format');
  });
});

describe('validateVpcId', () => {
  it('accepts a valid vpc id', () => {
    expect(validateVpcId('vpc-0123456789abcdef0')).toBe(true);
  });
  it('rejects a malformed vpc id', () => {
    expect(typeof validateVpcId('vpc-xyz')).toBe('string');
  });
  it('accepts 8-char lowercase-hex vpc id', () => {
    expect(validateVpcId('vpc-0a1b2c3d')).toBe(true);
  });
  it('rejects uppercase vpc id', () => {
    expect(validateVpcId('vpc-ABCDEFGH')).toBeTypeOf('string');
  });
  it('rejects non-hex vpc id', () => {
    expect(validateVpcId('vpc-zzzzzzzz')).toBeTypeOf('string');
  });
  it('rejects 9-char vpc id', () => {
    expect(validateVpcId('vpc-123456789')).toBeTypeOf('string');
  });
});

describe('validateSubnetIds — strict format', () => {
  it('accepts 8-char lowercase-hex subnet id', () => {
    expect(validateSubnetIds('subnet-0a1b2c3d')).toBe(true);
  });
  it('rejects uppercase subnet id', () => {
    expect(validateSubnetIds('subnet-ABCDEFGH')).toBeTypeOf('string');
  });
  it('rejects non-hex subnet id', () => {
    expect(validateSubnetIds('subnet-zzzzzzzz')).toBeTypeOf('string');
  });
  it('rejects 9-char subnet id', () => {
    expect(validateSubnetIds('subnet-0a1b2c3d4')).toBeTypeOf('string');
  });
});

describe('validateSecurityGroupIds — strict format', () => {
  it('accepts 8-char lowercase-hex sg id', () => {
    expect(validateSecurityGroupIds('sg-0a1b2c3d')).toBe(true);
  });
  it('rejects uppercase sg id', () => {
    expect(validateSecurityGroupIds('sg-ZZZZZZZZ')).toBeTypeOf('string');
  });
  it('rejects non-hex sg id', () => {
    expect(validateSecurityGroupIds('sg-zzzzzzzz')).toBeTypeOf('string');
  });
  it('rejects 9-char sg id', () => {
    expect(validateSecurityGroupIds('sg-0a1b2c3d4')).toBeTypeOf('string');
  });
});

describe('validateVpcOptions vpcId requirement', () => {
  it('requires vpcId for Container + VPC', () => {
    const r = validateVpcOptions(
      { networkMode: 'VPC', subnets: 'subnet-0123456789abcdef0', securityGroups: 'sg-0123456789abcdef0' },
      'Container'
    );
    expect(r.valid).toBe(false);
  });
  it('accepts Container + VPC with vpcId', () => {
    const r = validateVpcOptions(
      {
        networkMode: 'VPC',
        subnets: 'subnet-0123456789abcdef0',
        securityGroups: 'sg-0123456789abcdef0',
        vpcId: 'vpc-0123456789abcdef0',
      },
      'Container'
    );
    expect(r.valid).toBe(true);
  });
  it('does not require vpcId for CodeZip + VPC', () => {
    const r = validateVpcOptions(
      { networkMode: 'VPC', subnets: 'subnet-0123456789abcdef0', securityGroups: 'sg-0123456789abcdef0' },
      'CodeZip'
    );
    expect(r.valid).toBe(true);
  });
});

describe('resolveVpcIdFromSubnets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the VPC ID when all subnets resolve to one VPC', async () => {
    mockSend.mockResolvedValue({
      Subnets: [
        { SubnetId: 'subnet-0000000000000000a', VpcId: 'vpc-0123456789abcdef0' },
        { SubnetId: 'subnet-0000000000000000b', VpcId: 'vpc-0123456789abcdef0' },
      ],
    });
    const vpcId = await resolveVpcIdFromSubnets(['subnet-0000000000000000a', 'subnet-0000000000000000b'], 'us-east-1');
    expect(vpcId).toBe('vpc-0123456789abcdef0');
  });

  it('does NOT blindly trust Subnets[0]: rejects when subnets span multiple VPCs', async () => {
    // DescribeSubnets does not guarantee response order, and cross-VPC subnets would misconfigure the
    // build. The result must not silently be whichever VpcId happened to come back first.
    mockSend.mockResolvedValue({
      Subnets: [
        { SubnetId: 'subnet-0000000000000000a', VpcId: 'vpc-0000000000000000a' },
        { SubnetId: 'subnet-0000000000000000b', VpcId: 'vpc-0000000000000000b' },
      ],
    });
    await expect(
      resolveVpcIdFromSubnets(['subnet-0000000000000000a', 'subnet-0000000000000000b'], 'us-east-1')
    ).rejects.toThrow(/span multiple VPCs/);
  });

  it('throws naming ec2:DescribeSubnets when the API call fails', async () => {
    mockSend.mockRejectedValue(new Error('AccessDenied'));
    await expect(resolveVpcIdFromSubnets(['subnet-0000000000000000a'], 'us-east-1')).rejects.toThrow(
      /ec2:DescribeSubnets permission is required/
    );
  });

  it('throws when DescribeSubnets returns no VPC ID', async () => {
    mockSend.mockResolvedValue({ Subnets: [] });
    await expect(resolveVpcIdFromSubnets(['subnet-0000000000000000a'], 'us-east-1')).rejects.toThrow(
      /returned no VPC ID/
    );
  });

  it('lists all requested subnets in the error (not just the first) on failure', async () => {
    mockSend.mockRejectedValue(new Error('boom'));
    await expect(
      resolveVpcIdFromSubnets(['subnet-0000000000000000a', 'subnet-0000000000000000b'], 'us-east-1')
    ).rejects.toThrow(/subnet-0000000000000000a, subnet-0000000000000000b/);
  });
});

describe('validateVpcOptions - format validation', () => {
  it('rejects VPC mode with invalid subnet format', () => {
    const result = validateVpcOptions({
      networkMode: 'VPC',
      subnets: 'not-a-subnet',
      securityGroups: 'sg-12345678',
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Invalid subnet ID format');
  });

  it('rejects VPC mode with invalid security group format', () => {
    const result = validateVpcOptions({
      networkMode: 'VPC',
      subnets: 'subnet-12345678',
      securityGroups: 'not-a-sg',
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Invalid security group ID format');
  });

  it('accepts VPC mode with valid subnet and security group formats', () => {
    const result = validateVpcOptions({
      networkMode: 'VPC',
      subnets: 'subnet-12345678, subnet-abcdef12',
      securityGroups: 'sg-12345678',
    });
    expect(result.valid).toBe(true);
  });
});
