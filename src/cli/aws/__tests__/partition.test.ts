import { arnPrefix, consoleDomain, dnsSuffix, getPartition, serviceEndpoint } from '../partition';
import { describe, expect, it } from 'vitest';

describe('getPartition', () => {
  it('returns aws for standard commercial regions', () => {
    expect(getPartition('us-east-1')).toBe('aws');
    expect(getPartition('eu-west-1')).toBe('aws');
    expect(getPartition('ap-southeast-1')).toBe('aws');
  });

  it('returns aws-us-gov for GovCloud regions', () => {
    expect(getPartition('us-gov-west-1')).toBe('aws-us-gov');
    expect(getPartition('us-gov-east-1')).toBe('aws-us-gov');
  });

  it('returns aws-cn for China regions', () => {
    expect(getPartition('cn-north-1')).toBe('aws-cn');
    expect(getPartition('cn-northwest-1')).toBe('aws-cn');
  });
});

describe('arnPrefix', () => {
  it('returns arn:aws for commercial regions', () => {
    expect(arnPrefix('us-east-1')).toBe('arn:aws');
  });

  it('returns arn:aws-us-gov for GovCloud regions', () => {
    expect(arnPrefix('us-gov-west-1')).toBe('arn:aws-us-gov');
  });

  it('returns arn:aws-cn for China regions', () => {
    expect(arnPrefix('cn-north-1')).toBe('arn:aws-cn');
  });
});

describe('dnsSuffix', () => {
  it('returns amazonaws.com for commercial regions', () => {
    expect(dnsSuffix('us-east-1')).toBe('amazonaws.com');
  });

  it('returns amazonaws.com for GovCloud regions', () => {
    expect(dnsSuffix('us-gov-west-1')).toBe('amazonaws.com');
  });

  it('returns amazonaws.com.cn for China regions', () => {
    expect(dnsSuffix('cn-north-1')).toBe('amazonaws.com.cn');
  });
});

describe('serviceEndpoint', () => {
  it('builds correct endpoint for commercial regions', () => {
    expect(serviceEndpoint('bedrock-agentcore', 'us-east-1')).toBe('bedrock-agentcore.us-east-1.amazonaws.com');
  });

  it('builds correct endpoint for GovCloud regions', () => {
    expect(serviceEndpoint('bedrock-agentcore', 'us-gov-west-1')).toBe('bedrock-agentcore.us-gov-west-1.amazonaws.com');
  });

  it('builds correct endpoint for China regions', () => {
    expect(serviceEndpoint('bedrock-agentcore', 'cn-north-1')).toBe('bedrock-agentcore.cn-north-1.amazonaws.com.cn');
  });
});

describe('consoleDomain', () => {
  it('returns console.aws.amazon.com for commercial regions', () => {
    expect(consoleDomain('us-east-1')).toBe('console.aws.amazon.com');
  });

  it('returns console.amazonaws-us-gov.com for GovCloud regions', () => {
    expect(consoleDomain('us-gov-west-1')).toBe('console.amazonaws-us-gov.com');
  });

  it('returns console.amazonaws.cn for China regions', () => {
    expect(consoleDomain('cn-north-1')).toBe('console.amazonaws.cn');
  });
});
