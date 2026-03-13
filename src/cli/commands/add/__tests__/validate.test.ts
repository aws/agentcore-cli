import { validateAddAgentOptions } from '../validate.js';
import { describe, expect, it } from 'vitest';

describe('validateAddAgentOptions - VPC validation', () => {
  const baseOptions = {
    name: 'TestAgent',
    type: 'byo' as const,
    language: 'Python' as const,
    framework: 'Strands' as const,
    modelProvider: 'Bedrock' as const,
    build: 'CodeZip',
    codeLocation: './app/test/',
  };

  it('accepts valid VPC options', () => {
    const result = validateAddAgentOptions({
      ...baseOptions,
      networkMode: 'VPC',
      subnets: 'subnet-12345678',
      securityGroups: 'sg-12345678',
    });
    expect(result.valid).toBe(true);
  });

  it('accepts PUBLIC network mode without VPC options', () => {
    const result = validateAddAgentOptions({
      ...baseOptions,
      networkMode: 'PUBLIC',
    });
    expect(result.valid).toBe(true);
  });

  it('rejects invalid network mode', () => {
    const result = validateAddAgentOptions({
      ...baseOptions,
      networkMode: 'INVALID',
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Invalid network mode');
  });

  it('rejects VPC mode without subnets', () => {
    const result = validateAddAgentOptions({
      ...baseOptions,
      networkMode: 'VPC',
      securityGroups: 'sg-12345678',
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('--subnets is required');
  });

  it('rejects VPC mode without security groups', () => {
    const result = validateAddAgentOptions({
      ...baseOptions,
      networkMode: 'VPC',
      subnets: 'subnet-12345678',
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('--security-groups is required');
  });

  it('rejects subnets without VPC mode', () => {
    const result = validateAddAgentOptions({
      ...baseOptions,
      subnets: 'subnet-12345678',
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('only valid with --network-mode VPC');
  });

  it('rejects security groups without VPC mode', () => {
    const result = validateAddAgentOptions({
      ...baseOptions,
      securityGroups: 'sg-12345678',
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('only valid with --network-mode VPC');
  });
});
