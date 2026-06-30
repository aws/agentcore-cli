import type { AddHarnessCliOptions } from '../types';
import { validateAddHarnessOptions } from '../validate';
import { describe, expect, it } from 'vitest';

const base: AddHarnessCliOptions = {
  name: 'h1',
  modelProvider: 'bedrock',
  modelId: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
};

describe('validateAddHarnessOptions — VPC network-mode guard', () => {
  it('rejects VPC mode without subnets', () => {
    const result = validateAddHarnessOptions({
      ...base,
      networkMode: 'VPC',
      securityGroups: 'sg-0a1b2c3d',
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('--subnets is required');
  });

  it('rejects VPC mode without security groups', () => {
    const result = validateAddHarnessOptions({
      ...base,
      networkMode: 'VPC',
      subnets: 'subnet-0a1b2c3d',
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('--security-groups is required');
  });

  it('accepts valid VPC options for a non-container harness', () => {
    const result = validateAddHarnessOptions({
      ...base,
      networkMode: 'VPC',
      subnets: 'subnet-0a1b2c3d',
      securityGroups: 'sg-0a1b2c3d',
    });
    expect(result.valid).toBe(true);
  });

  it('rejects a container (dockerfile) harness with --network-mode VPC and no --vpc-id', () => {
    const result = validateAddHarnessOptions({
      ...base,
      container: './Dockerfile',
      networkMode: 'VPC',
      subnets: 'subnet-0a1b2c3d',
      securityGroups: 'sg-0a1b2c3d',
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('--vpc-id is required');
  });

  it('accepts a container (dockerfile) harness with --network-mode VPC and a valid --vpc-id', () => {
    const result = validateAddHarnessOptions({
      ...base,
      container: './Dockerfile',
      networkMode: 'VPC',
      subnets: 'subnet-0a1b2c3d',
      securityGroups: 'sg-0a1b2c3d',
      vpcId: 'vpc-0a1b2c3d',
    });
    expect(result.valid).toBe(true);
  });

  it('does not require --vpc-id for a container URI (non-dockerfile) harness in VPC mode', () => {
    const result = validateAddHarnessOptions({
      ...base,
      container: '123456789012.dkr.ecr.us-east-1.amazonaws.com/my-image:latest',
      networkMode: 'VPC',
      subnets: 'subnet-0a1b2c3d',
      securityGroups: 'sg-0a1b2c3d',
    });
    expect(result.valid).toBe(true);
  });

  it('rejects subnets provided without --network-mode VPC', () => {
    const result = validateAddHarnessOptions({
      ...base,
      subnets: 'subnet-0a1b2c3d',
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('only valid with --network-mode VPC');
  });

  it('rejects --vpc-id provided without --network-mode VPC', () => {
    const result = validateAddHarnessOptions({
      ...base,
      vpcId: 'vpc-0a1b2c3d',
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('only valid with --network-mode VPC');
  });
});
