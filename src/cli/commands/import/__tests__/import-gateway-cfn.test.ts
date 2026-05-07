/**
 * Tests for buildCredentialArnMap and CFN template resource matching logic
 * used in the gateway import flow.
 */
import { buildCredentialArnMap } from '../import-gateway';
import type { CfnTemplate } from '../template-utils';
import { findLogicalIdByProperty, findLogicalIdsByType } from '../template-utils';
import { describe, expect, it } from 'vitest';

// ============================================================================
// Part 1: buildCredentialArnMap
// ============================================================================

describe('buildCredentialArnMap', () => {
  it('reads credentials from deployed state', async () => {
    const configIO = {
      readDeployedState: () =>
        Promise.resolve({
          targets: {
            default: {
              resources: {
                credentials: {
                  myCred: { credentialProviderArn: 'arn:aws:bedrock:us-east-1:123456789012:credential/myCred' },
                },
              },
            },
          },
        }),
    };

    const map = await buildCredentialArnMap(configIO, 'default');
    expect(map.size).toBe(1);
    expect(map.get('arn:aws:bedrock:us-east-1:123456789012:credential/myCred')).toBe('myCred');
  });

  it('handles multiple credentials', async () => {
    const configIO = {
      readDeployedState: () =>
        Promise.resolve({
          targets: {
            default: {
              resources: {
                credentials: {
                  oauthCred: { credentialProviderArn: 'arn:aws:bedrock:us-east-1:123456789012:credential/oauth' },
                  apiKeyCred: { credentialProviderArn: 'arn:aws:bedrock:us-east-1:123456789012:credential/apikey' },
                },
              },
            },
          },
        }),
    };

    const map = await buildCredentialArnMap(configIO, 'default');
    expect(map.size).toBe(2);
    expect(map.get('arn:aws:bedrock:us-east-1:123456789012:credential/oauth')).toBe('oauthCred');
    expect(map.get('arn:aws:bedrock:us-east-1:123456789012:credential/apikey')).toBe('apiKeyCred');
  });

  it('returns empty map when readDeployedState throws', async () => {
    const configIO = {
      readDeployedState: () => Promise.reject(new Error('No deployed state file')),
    };

    const map = await buildCredentialArnMap(configIO, 'default');
    expect(map.size).toBe(0);
  });

  it('returns empty map when no credentials key exists', async () => {
    const configIO = {
      readDeployedState: () =>
        Promise.resolve({
          targets: {
            default: {
              resources: {},
            },
          },
        }),
    };

    const map = await buildCredentialArnMap(configIO, 'default');
    expect(map.size).toBe(0);
  });

  it('returns empty map when targets is empty', async () => {
    const configIO = {
      readDeployedState: () => Promise.resolve({ targets: {} }),
    };

    const map = await buildCredentialArnMap(configIO, 'default');
    expect(map.size).toBe(0);
  });
});

// ============================================================================
// Part 2: CFN template matching (findLogicalIdByProperty, findLogicalIdsByType)
// ============================================================================

describe('findLogicalIdByProperty – gateway scenarios', () => {
  it('finds gateway by Name = projectName-localName', () => {
    const template: CfnTemplate = {
      Resources: {
        MyGatewayResource: {
          Type: 'AWS::BedrockAgentCore::Gateway',
          Properties: {
            Name: 'myProject-myGateway',
          },
        },
      },
    };

    const result = findLogicalIdByProperty(template, 'AWS::BedrockAgentCore::Gateway', 'Name', 'myProject-myGateway');
    expect(result).toBe('MyGatewayResource');
  });

  it('finds gateway by resourceName (localName only) as fallback', () => {
    const template: CfnTemplate = {
      Resources: {
        GatewayA: {
          Type: 'AWS::BedrockAgentCore::Gateway',
          Properties: {
            Name: 'someOtherName',
          },
        },
        GatewayB: {
          Type: 'AWS::BedrockAgentCore::Gateway',
          Properties: {
            Name: 'myGateway',
          },
        },
      },
    };

    const result = findLogicalIdByProperty(template, 'AWS::BedrockAgentCore::Gateway', 'Name', 'myGateway');
    expect(result).toBe('GatewayB');
  });

  it('finds target by Name property', () => {
    const template: CfnTemplate = {
      Resources: {
        TargetLogical1: {
          Type: 'AWS::BedrockAgentCore::GatewayTarget',
          Properties: {
            Name: 'mcpTarget',
          },
        },
      },
    };

    const result = findLogicalIdByProperty(template, 'AWS::BedrockAgentCore::GatewayTarget', 'Name', 'mcpTarget');
    expect(result).toBe('TargetLogical1');
  });
});

describe('findLogicalIdsByType – gateway fallback', () => {
  it('returns the single gateway when name-based lookup fails', () => {
    const template: CfnTemplate = {
      Resources: {
        OnlyGateway: {
          Type: 'AWS::BedrockAgentCore::Gateway',
          Properties: {
            Name: 'completely-different-name',
          },
        },
        SomeRole: {
          Type: 'AWS::IAM::Role',
          Properties: {},
        },
      },
    };

    // Name-based lookup fails
    const byName = findLogicalIdByProperty(template, 'AWS::BedrockAgentCore::Gateway', 'Name', 'myProject-myGateway');
    expect(byName).toBeUndefined();

    // Type-based fallback returns the single gateway
    const allGateways = findLogicalIdsByType(template, 'AWS::BedrockAgentCore::Gateway');
    expect(allGateways).toHaveLength(1);
    expect(allGateways[0]).toBe('OnlyGateway');
  });

  it('returns single target for fallback when one target and one in targetIdMap', () => {
    const template: CfnTemplate = {
      Resources: {
        OnlyTarget: {
          Type: 'AWS::BedrockAgentCore::GatewayTarget',
          Properties: {
            Name: 'different-name',
          },
        },
      },
    };

    const allTargets = findLogicalIdsByType(template, 'AWS::BedrockAgentCore::GatewayTarget');
    expect(allTargets).toHaveLength(1);
    expect(allTargets[0]).toBe('OnlyTarget');
  });

  it('returns multiple targets preventing fallback when more than one exists', () => {
    const template: CfnTemplate = {
      Resources: {
        Target1: {
          Type: 'AWS::BedrockAgentCore::GatewayTarget',
          Properties: { Name: 'targetA' },
        },
        Target2: {
          Type: 'AWS::BedrockAgentCore::GatewayTarget',
          Properties: { Name: 'targetB' },
        },
      },
    };

    const allTargets = findLogicalIdsByType(template, 'AWS::BedrockAgentCore::GatewayTarget');
    expect(allTargets).toHaveLength(2);

    // Name-based matching must succeed — fallback is not safe with multiple targets
    // Simulate the import-gateway logic: only fallback if allTargets.length === 1 && targetIdMap.size === 1
    const targetIdMap = new Map([
      ['targetA', 'tid-1'],
      ['targetB', 'tid-2'],
    ]);
    const shouldFallback = allTargets.length === 1 && targetIdMap.size === 1;
    expect(shouldFallback).toBe(false);
  });
});

// ============================================================================
// Part 3: Fn::Join / Fn::Sub patterns in findLogicalIdByProperty
// ============================================================================

describe('findLogicalIdByProperty – intrinsic function patterns', () => {
  it('matches Fn::Join Name via regex second pass', () => {
    const template: CfnTemplate = {
      Resources: {
        JoinGateway: {
          Type: 'AWS::BedrockAgentCore::Gateway',
          Properties: {
            Name: { 'Fn::Join': ['-', ['prefix', 'myGateway']] },
          },
        },
      },
    };

    const result = findLogicalIdByProperty(template, 'AWS::BedrockAgentCore::Gateway', 'Name', 'myGateway');
    expect(result).toBe('JoinGateway');
  });

  it('avoids false substring matches with regex boundary check', () => {
    const template: CfnTemplate = {
      Resources: {
        WrongGateway: {
          Type: 'AWS::BedrockAgentCore::Gateway',
          Properties: {
            Name: { 'Fn::Join': ['-', ['prefix', 'myGateway_v2']] },
          },
        },
      },
    };

    const result = findLogicalIdByProperty(template, 'AWS::BedrockAgentCore::Gateway', 'Name', 'myGateway');
    // "myGateway" should NOT match "myGateway_v2" due to boundary check
    expect(result).toBeUndefined();
  });

  it('matches Fn::Sub Name via regex second pass', () => {
    const template: CfnTemplate = {
      Resources: {
        SubGateway: {
          Type: 'AWS::BedrockAgentCore::Gateway',
          Properties: {
            Name: { 'Fn::Sub': '${AWS::StackName}-myGateway' },
          },
        },
      },
    };

    const result = findLogicalIdByProperty(template, 'AWS::BedrockAgentCore::Gateway', 'Name', 'myGateway');
    expect(result).toBe('SubGateway');
  });
});
