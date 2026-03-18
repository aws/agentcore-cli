import { parseCommaSeparatedList, validateSecurityGroupIds, validateSubnetIds, validateVpcOptions } from '../vpc-utils';
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
    expect(validateSubnetIds('subnet-12345678abcdef12')).toBe(true);
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
    expect(validateSecurityGroupIds('sg-12345678abcdef12')).toBe(true);
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
