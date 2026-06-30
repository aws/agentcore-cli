import {
  parseCommaSeparatedList,
  validateSecurityGroupIds,
  validateSubnetIds,
  validateVpcId,
  validateVpcOptions,
} from '../vpc-utils';
import { describe, expect, it } from 'vitest';

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
