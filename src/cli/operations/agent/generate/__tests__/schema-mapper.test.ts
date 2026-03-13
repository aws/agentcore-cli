import { computeManagedOAuthCredentialName } from '../../../../primitives/credential-utils.js';
import { mapByoConfigToAgent } from '../../../../tui/screens/agent/useAddAgent.js';
import { mapGenerateConfigToAgent } from '../schema-mapper.js';
import { describe, expect, it } from 'vitest';

describe('mapGenerateConfigToAgent - VPC support', () => {
  const baseConfig = {
    projectName: 'TestAgent',
    buildType: 'CodeZip' as const,
    sdk: 'Strands' as const,
    modelProvider: 'Bedrock' as const,
    memory: 'none' as const,
    language: 'Python' as const,
  };

  it('defaults to PUBLIC network mode when networkMode is absent', () => {
    const result = mapGenerateConfigToAgent(baseConfig);
    expect(result.networkMode).toBe('PUBLIC');
    expect(result.networkConfig).toBeUndefined();
  });

  it('uses PUBLIC network mode when explicitly set', () => {
    const result = mapGenerateConfigToAgent({ ...baseConfig, networkMode: 'PUBLIC' });
    expect(result.networkMode).toBe('PUBLIC');
    expect(result.networkConfig).toBeUndefined();
  });

  it('produces networkConfig for VPC mode with subnets and security groups', () => {
    const result = mapGenerateConfigToAgent({
      ...baseConfig,
      networkMode: 'VPC',
      subnets: ['subnet-12345678', 'subnet-abcdef12'],
      securityGroups: ['sg-12345678'],
    });
    expect(result.networkMode).toBe('VPC');
    expect(result.networkConfig).toEqual({
      subnets: ['subnet-12345678', 'subnet-abcdef12'],
      securityGroups: ['sg-12345678'],
    });
  });

  it('does not produce networkConfig for VPC mode without subnets', () => {
    const result = mapGenerateConfigToAgent({
      ...baseConfig,
      networkMode: 'VPC',
    });
    expect(result.networkMode).toBe('VPC');
    expect(result.networkConfig).toBeUndefined();
  });
});

describe('mapByoConfigToAgent - VPC support', () => {
  const baseByoConfig = {
    name: 'MyByo',
    agentType: 'byo' as const,
    codeLocation: 'app/MyByo/',
    entrypoint: 'main.py',
    language: 'Python' as const,
    buildType: 'CodeZip' as const,
    framework: 'Strands' as const,
    modelProvider: 'Bedrock' as const,
    pythonVersion: 'PYTHON_3_12' as const,
    memory: 'none' as const,
  };

  it('defaults to PUBLIC network mode when networkMode is undefined', () => {
    const result = mapByoConfigToAgent(baseByoConfig);
    expect(result.networkMode).toBe('PUBLIC');
    expect(result.networkConfig).toBeUndefined();
  });

  it('produces networkConfig for VPC mode with subnets and security groups', () => {
    const result = mapByoConfigToAgent({
      ...baseByoConfig,
      networkMode: 'VPC',
      subnets: ['subnet-12345678'],
      securityGroups: ['sg-abcdef12'],
    });
    expect(result.networkMode).toBe('VPC');
    expect(result.networkConfig).toEqual({
      subnets: ['subnet-12345678'],
      securityGroups: ['sg-abcdef12'],
    });
  });

  it('does not produce networkConfig for VPC mode without subnets', () => {
    const result = mapByoConfigToAgent({
      ...baseByoConfig,
      networkMode: 'VPC',
    });
    expect(result.networkMode).toBe('VPC');
    expect(result.networkConfig).toBeUndefined();
  });

  it('does not produce networkConfig for PUBLIC mode even with subnets', () => {
    const result = mapByoConfigToAgent({
      ...baseByoConfig,
      networkMode: 'PUBLIC',
      subnets: ['subnet-12345678'],
      securityGroups: ['sg-abcdef12'],
    });
    expect(result.networkMode).toBe('PUBLIC');
    expect(result.networkConfig).toBeUndefined();
  });
});

describe('gateway credential provider name mapping', () => {
  it('computeManagedOAuthCredentialName produces the correct suffix', () => {
    // Regression test: the managed credential name must use '-oauth' suffix.
    // GatewayPrimitive creates it, schema-mapper looks it up, AddGatewayScreen displays it.
    // All three now use computeManagedOAuthCredentialName to stay in sync.
    expect(computeManagedOAuthCredentialName('my-gateway')).toBe('my-gateway-oauth');
    expect(computeManagedOAuthCredentialName('test')).toBe('test-oauth');
  });
});
