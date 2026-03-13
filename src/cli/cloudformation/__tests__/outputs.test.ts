import {
  buildDeployedState,
  parseGatewayOutputs,
  parseMemoryOutputs,
  parsePolicyEngineOutputs,
  parsePolicyOutputs,
} from '../outputs';
import { describe, expect, it } from 'vitest';

describe('buildDeployedState', () => {
  it('persists identityKmsKeyArn when provided', () => {
    const agents = {
      TestAgent: {
        runtimeId: 'rt-123',
        runtimeArn: 'arn:aws:bedrock:us-east-1:123456789012:agent-runtime/rt-123',
        roleArn: 'arn:aws:iam::123456789012:role/TestRole',
      },
    };

    const result = buildDeployedState({
      targetName: 'default',
      stackName: 'TestStack',
      agents,
      gateways: {},
      identityKmsKeyArn: 'arn:aws:kms:us-east-1:123456789012:key/abc-123',
    });

    expect(result.targets.default!.resources?.identityKmsKeyArn).toBe('arn:aws:kms:us-east-1:123456789012:key/abc-123');
  });

  it('omits identityKmsKeyArn when not provided', () => {
    const agents = {
      TestAgent: {
        runtimeId: 'rt-123',
        runtimeArn: 'arn:aws:bedrock:us-east-1:123456789012:agent-runtime/rt-123',
        roleArn: 'arn:aws:iam::123456789012:role/TestRole',
      },
    };

    const result = buildDeployedState({ targetName: 'default', stackName: 'TestStack', agents, gateways: {} });

    expect(result.targets.default!.resources?.identityKmsKeyArn).toBeUndefined();
  });

  it('preserves existing state while adding new target with kmsKeyArn', () => {
    const existingState = {
      targets: {
        prod: {
          resources: {
            agents: {},
            stackName: 'ProdStack',
          },
        },
      },
    };

    const result = buildDeployedState({
      targetName: 'dev',
      stackName: 'DevStack',
      agents: {},
      gateways: {},
      existingState,
      identityKmsKeyArn: 'arn:aws:kms:us-east-1:123456789012:key/dev-key',
    });

    expect(result.targets.prod!.resources?.stackName).toBe('ProdStack');
    expect(result.targets.dev!.resources?.identityKmsKeyArn).toBe('arn:aws:kms:us-east-1:123456789012:key/dev-key');
  });

  it('includes credentials in deployed state when provided', () => {
    const agents = {
      TestAgent: {
        runtimeId: 'rt-123',
        runtimeArn: 'arn:aws:bedrock:us-east-1:123456789012:agent-runtime/rt-123',
        roleArn: 'arn:aws:iam::123456789012:role/TestRole',
      },
    };

    const credentials = {
      'test-cred': {
        credentialProviderArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:test-cred',
      },
    };

    const result = buildDeployedState({
      targetName: 'default',
      stackName: 'TestStack',
      agents,
      gateways: {},
      credentials,
    });

    expect(result.targets.default!.resources?.credentials).toEqual(credentials);
  });

  it('omits credentials field when credentials is undefined', () => {
    const agents = {
      TestAgent: {
        runtimeId: 'rt-123',
        runtimeArn: 'arn:aws:bedrock:us-east-1:123456789012:agent-runtime/rt-123',
        roleArn: 'arn:aws:iam::123456789012:role/TestRole',
      },
    };

    const result = buildDeployedState({ targetName: 'default', stackName: 'TestStack', agents, gateways: {} });

    expect(result.targets.default!.resources?.credentials).toBeUndefined();
  });

  it('omits credentials field when credentials is empty object', () => {
    const agents = {
      TestAgent: {
        runtimeId: 'rt-123',
        runtimeArn: 'arn:aws:bedrock:us-east-1:123456789012:agent-runtime/rt-123',
        roleArn: 'arn:aws:iam::123456789012:role/TestRole',
      },
    };

    const result = buildDeployedState({
      targetName: 'default',
      stackName: 'TestStack',
      agents,
      gateways: {},
      credentials: {},
    });

    expect(result.targets.default!.resources?.credentials).toBeUndefined();
  });

  it('includes memories in deployed state when provided', () => {
    const memories = {
      'my-memory': {
        memoryId: 'mem-123',
        memoryArn: 'arn:aws:bedrock:us-east-1:123456789012:memory/mem-123',
      },
    };

    const result = buildDeployedState({
      targetName: 'default',
      stackName: 'TestStack',
      agents: {},
      gateways: {},
      memories,
    });

    expect(result.targets.default!.resources?.memories).toEqual(memories);
  });

  it('omits memories field when memories is empty object', () => {
    const result = buildDeployedState({
      targetName: 'default',
      stackName: 'TestStack',
      agents: {},
      gateways: {},
      memories: {},
    });

    expect(result.targets.default!.resources?.memories).toBeUndefined();
  });

  it('omits agents field when agents is empty object', () => {
    const result = buildDeployedState({ targetName: 'default', stackName: 'TestStack', agents: {}, gateways: {} });

    expect(result.targets.default!.resources?.agents).toBeUndefined();
  });
});

describe('parseGatewayOutputs', () => {
  it('extracts gateway outputs matching pattern', () => {
    const outputs = {
      GatewayMyGatewayIdOutput3E11FAB4: 'gw-123',
      GatewayMyGatewayArnOutput3E11FAB4: 'arn:aws:bedrock:us-east-1:123:gateway/gw-123',
      GatewayMyGatewayUrlOutput3E11FAB4: 'https://api.gateway.url',
      GatewayAnotherGatewayIdOutputABC123: 'gw-456',
      GatewayAnotherGatewayArnOutputABC123: 'arn:aws:bedrock:us-east-1:123:gateway/gw-456',
      GatewayAnotherGatewayUrlOutputABC123: 'https://another.gateway.url',
      UnrelatedOutput: 'some-value',
    };

    const gatewaySpecs = {
      'my-gateway': {},
      'another-gateway': {},
    };

    const result = parseGatewayOutputs(outputs, gatewaySpecs);

    expect(result).toEqual({
      'my-gateway': {
        gatewayId: 'gw-123',
        gatewayArn: 'arn:aws:bedrock:us-east-1:123:gateway/gw-123',
        gatewayUrl: 'https://api.gateway.url',
      },
      'another-gateway': {
        gatewayId: 'gw-456',
        gatewayArn: 'arn:aws:bedrock:us-east-1:123:gateway/gw-456',
        gatewayUrl: 'https://another.gateway.url',
      },
    });
  });

  it('handles missing gateway outputs gracefully', () => {
    const outputs = {
      UnrelatedOutput: 'some-value',
      AnotherOutput: 'another-value',
    };

    const gatewaySpecs = {
      'my-gateway': {},
    };

    const result = parseGatewayOutputs(outputs, gatewaySpecs);

    expect(result).toEqual({});
  });

  it('maps multiple gateways correctly', () => {
    const outputs = {
      GatewayFirstGatewayArnOutput123: 'arn:first',
      GatewayFirstGatewayUrlOutput123: 'https://first.url',
      GatewaySecondGatewayArnOutput456: 'arn:second',
      GatewaySecondGatewayUrlOutput456: 'https://second.url',
      GatewayThirdGatewayArnOutput789: 'arn:third',
      GatewayThirdGatewayUrlOutput789: 'https://third.url',
    };

    const gatewaySpecs = {
      'first-gateway': {},
      'second-gateway': {},
      'third-gateway': {},
    };

    const result = parseGatewayOutputs(outputs, gatewaySpecs);

    expect(Object.keys(result)).toHaveLength(3);
    expect(result['first-gateway']?.gatewayUrl).toBe('https://first.url');
    expect(result['second-gateway']?.gatewayUrl).toBe('https://second.url');
    expect(result['third-gateway']?.gatewayUrl).toBe('https://third.url');
  });
});

describe('parseMemoryOutputs', () => {
  it('extracts memory outputs matching pattern', () => {
    const outputs = {
      ApplicationMemoryMyMemoryIdOutputABC123: 'mem-123',
      ApplicationMemoryMyMemoryArnOutputDEF456: 'arn:aws:bedrock:us-east-1:123:memory/mem-123',
      UnrelatedOutput: 'some-value',
    };

    const result = parseMemoryOutputs(outputs, ['my-memory']);

    expect(result).toEqual({
      'my-memory': {
        memoryId: 'mem-123',
        memoryArn: 'arn:aws:bedrock:us-east-1:123:memory/mem-123',
      },
    });
  });

  it('handles multiple memories', () => {
    const outputs = {
      ApplicationMemoryFirstMemoryIdOutput123: 'mem-1',
      ApplicationMemoryFirstMemoryArnOutput123: 'arn:mem-1',
      ApplicationMemorySecondMemoryIdOutput456: 'mem-2',
      ApplicationMemorySecondMemoryArnOutput456: 'arn:mem-2',
    };

    const result = parseMemoryOutputs(outputs, ['first-memory', 'second-memory']);

    expect(Object.keys(result)).toHaveLength(2);
    expect(result['first-memory']?.memoryId).toBe('mem-1');
    expect(result['second-memory']?.memoryId).toBe('mem-2');
  });

  it('returns empty record when no memory outputs found', () => {
    const outputs = {
      UnrelatedOutput: 'some-value',
    };

    const result = parseMemoryOutputs(outputs, ['my-memory']);

    expect(result).toEqual({});
  });

  it('skips incomplete memory outputs (missing ARN)', () => {
    const outputs = {
      ApplicationMemoryMyMemoryIdOutputABC123: 'mem-123',
    };

    const result = parseMemoryOutputs(outputs, ['my-memory']);

    expect(result).toEqual({});
  });
});

describe('parsePolicyEngineOutputs', () => {
  it('extracts policy engine outputs matching pattern', () => {
    const outputs = {
      ApplicationPolicyEngineMyEngineIdOutputABC123: 'pe-123',
      ApplicationPolicyEngineMyEngineArnOutputDEF456: 'arn:aws:bedrock:us-east-1:123456789012:policy-engine/pe-123',
      UnrelatedOutput: 'some-value',
    };

    const result = parsePolicyEngineOutputs(outputs, ['MyEngine']);

    expect(result).toEqual({
      MyEngine: {
        policyEngineId: 'pe-123',
        policyEngineArn: 'arn:aws:bedrock:us-east-1:123456789012:policy-engine/pe-123',
      },
    });
  });

  it('handles multiple policy engines', () => {
    const outputs = {
      ApplicationPolicyEngineFirstEngineIdOutput123: 'pe-1',
      ApplicationPolicyEngineFirstEngineArnOutput123: 'arn:pe-1',
      ApplicationPolicyEngineSecondEngineIdOutput456: 'pe-2',
      ApplicationPolicyEngineSecondEngineArnOutput456: 'arn:pe-2',
    };

    const result = parsePolicyEngineOutputs(outputs, ['FirstEngine', 'SecondEngine']);

    expect(Object.keys(result)).toHaveLength(2);
    expect(result.FirstEngine?.policyEngineId).toBe('pe-1');
    expect(result.SecondEngine?.policyEngineId).toBe('pe-2');
  });

  it('returns empty record when no policy engine outputs found', () => {
    const outputs = {
      UnrelatedOutput: 'some-value',
    };

    const result = parsePolicyEngineOutputs(outputs, ['MyEngine']);

    expect(result).toEqual({});
  });

  it('skips incomplete policy engine outputs (missing ARN)', () => {
    const outputs = {
      ApplicationPolicyEngineMyEngineIdOutputABC123: 'pe-123',
    };

    const result = parsePolicyEngineOutputs(outputs, ['MyEngine']);

    expect(result).toEqual({});
  });
});

describe('parsePolicyOutputs', () => {
  it('extracts policy outputs matching pattern', () => {
    const outputs = {
      ApplicationPolicyMyEngineDenyAllIdOutputABC123: 'pol-123',
      ApplicationPolicyMyEngineDenyAllArnOutputDEF456: 'arn:aws:bedrock:us-east-1:123456789012:policy/pol-123',
      UnrelatedOutput: 'some-value',
    };

    const result = parsePolicyOutputs(outputs, [{ engineName: 'MyEngine', policyName: 'DenyAll' }]);

    expect(result).toEqual({
      'MyEngine/DenyAll': {
        policyId: 'pol-123',
        policyArn: 'arn:aws:bedrock:us-east-1:123456789012:policy/pol-123',
        engineName: 'MyEngine',
      },
    });
  });

  it('handles multiple policies across engines', () => {
    const outputs = {
      ApplicationPolicyEngine1Policy1IdOutput123: 'pol-1',
      ApplicationPolicyEngine1Policy1ArnOutput123: 'arn:pol-1',
      ApplicationPolicyEngine1Policy2IdOutput456: 'pol-2',
      ApplicationPolicyEngine1Policy2ArnOutput456: 'arn:pol-2',
    };

    const result = parsePolicyOutputs(outputs, [
      { engineName: 'Engine1', policyName: 'Policy1' },
      { engineName: 'Engine1', policyName: 'Policy2' },
    ]);

    expect(Object.keys(result)).toHaveLength(2);
    expect(result['Engine1/Policy1']?.policyId).toBe('pol-1');
    expect(result['Engine1/Policy2']?.policyId).toBe('pol-2');
  });

  it('returns empty record when no policy outputs found', () => {
    const outputs = {
      UnrelatedOutput: 'some-value',
    };

    const result = parsePolicyOutputs(outputs, [{ engineName: 'MyEngine', policyName: 'DenyAll' }]);

    expect(result).toEqual({});
  });
});

describe('buildDeployedState with policy data', () => {
  it('includes policyEngines in deployed state when provided', () => {
    const policyEngines = {
      MyEngine: {
        policyEngineId: 'pe-123',
        policyEngineArn: 'arn:aws:bedrock:us-east-1:123456789012:policy-engine/pe-123',
      },
    };

    const result = buildDeployedState({
      targetName: 'default',
      stackName: 'TestStack',
      agents: {},
      gateways: {},
      policyEngines,
    });

    expect(result.targets.default!.resources?.policyEngines).toEqual(policyEngines);
  });

  it('includes policies in deployed state when provided', () => {
    const policies = {
      'MyEngine/DenyAll': {
        policyId: 'pol-123',
        policyArn: 'arn:aws:bedrock:us-east-1:123456789012:policy/pol-123',
        engineName: 'MyEngine',
      },
    };

    const result = buildDeployedState({
      targetName: 'default',
      stackName: 'TestStack',
      agents: {},
      gateways: {},
      policies,
    });

    expect(result.targets.default!.resources?.policies).toEqual(policies);
  });

  it('omits policyEngines field when policyEngines is empty object', () => {
    const result = buildDeployedState({
      targetName: 'default',
      stackName: 'TestStack',
      agents: {},
      gateways: {},
      policyEngines: {},
    });

    expect(result.targets.default!.resources?.policyEngines).toBeUndefined();
  });

  it('omits policies field when policies is empty object', () => {
    const result = buildDeployedState({
      targetName: 'default',
      stackName: 'TestStack',
      agents: {},
      gateways: {},
      policies: {},
    });

    expect(result.targets.default!.resources?.policies).toBeUndefined();
  });

  it('omits policyEngines field when not provided', () => {
    const result = buildDeployedState({
      targetName: 'default',
      stackName: 'TestStack',
      agents: {},
      gateways: {},
    });

    expect(result.targets.default!.resources?.policyEngines).toBeUndefined();
  });
});
