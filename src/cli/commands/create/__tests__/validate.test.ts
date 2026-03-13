import { validateCreateOptions } from '../validate.js';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

describe('validateCreateOptions - VPC validation', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'agentcore-test-'));

  const baseOptions = {
    name: 'TestProject',
    language: 'Python',
    framework: 'Strands',
    modelProvider: 'Bedrock',
    memory: 'none',
  };

  it('accepts valid VPC options', () => {
    const result = validateCreateOptions(
      {
        ...baseOptions,
        networkMode: 'VPC',
        subnets: 'subnet-12345678',
        securityGroups: 'sg-12345678',
      },
      cwd
    );
    expect(result.valid).toBe(true);
  });

  it('accepts PUBLIC network mode without VPC options', () => {
    const result = validateCreateOptions(
      {
        ...baseOptions,
        networkMode: 'PUBLIC',
      },
      cwd
    );
    expect(result.valid).toBe(true);
  });

  it('accepts no network mode (defaults to PUBLIC)', () => {
    const result = validateCreateOptions({ ...baseOptions }, cwd);
    expect(result.valid).toBe(true);
  });

  it('rejects invalid network mode', () => {
    const result = validateCreateOptions(
      {
        ...baseOptions,
        networkMode: 'INVALID',
      },
      cwd
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Invalid network mode');
  });

  it('rejects VPC mode without subnets', () => {
    const result = validateCreateOptions(
      {
        ...baseOptions,
        networkMode: 'VPC',
        securityGroups: 'sg-12345678',
      },
      cwd
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain('--subnets is required');
  });

  it('rejects VPC mode without security groups', () => {
    const result = validateCreateOptions(
      {
        ...baseOptions,
        networkMode: 'VPC',
        subnets: 'subnet-12345678',
      },
      cwd
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain('--security-groups is required');
  });

  it('rejects subnets without VPC mode', () => {
    const result = validateCreateOptions(
      {
        ...baseOptions,
        subnets: 'subnet-12345678',
      },
      cwd
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain('only valid with --network-mode VPC');
  });

  it('rejects security groups without VPC mode', () => {
    const result = validateCreateOptions(
      {
        ...baseOptions,
        securityGroups: 'sg-12345678',
      },
      cwd
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain('only valid with --network-mode VPC');
  });

  it('rejects VPC mode missing both subnets and security groups', () => {
    const result = validateCreateOptions(
      {
        ...baseOptions,
        networkMode: 'VPC',
      },
      cwd
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain('--subnets is required');
  });
});
