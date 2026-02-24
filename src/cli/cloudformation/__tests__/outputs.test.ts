import { buildDeployedState, parseGatewayOutputs } from '../outputs';
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

    const result = buildDeployedState(
      'default',
      'TestStack',
      agents,
      {},
      undefined,
      'arn:aws:kms:us-east-1:123456789012:key/abc-123'
    );

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

    const result = buildDeployedState('default', 'TestStack', agents, {});

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

    const result = buildDeployedState(
      'dev',
      'DevStack',
      {},
      {},
      existingState,
      'arn:aws:kms:us-east-1:123456789012:key/dev-key'
    );

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

    const result = buildDeployedState('default', 'TestStack', agents, {}, undefined, undefined, credentials);

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

    const result = buildDeployedState('default', 'TestStack', agents, {});

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

    const result = buildDeployedState('default', 'TestStack', agents, {}, undefined, undefined, {});

    expect(result.targets.default!.resources?.credentials).toBeUndefined();
  });
});

describe('parseGatewayOutputs', () => {
  it('extracts gateway URL from outputs matching pattern', () => {
    const outputs = {
      GatewayMyGatewayUrlOutput3E11FAB4: 'https://api.gateway.url',
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
        gatewayId: 'my-gateway',
        gatewayArn: 'https://api.gateway.url',
      },
      'another-gateway': {
        gatewayId: 'another-gateway',
        gatewayArn: 'https://another.gateway.url',
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
      GatewayFirstGatewayUrlOutput123: 'https://first.url',
      GatewaySecondGatewayUrlOutput456: 'https://second.url',
      GatewayThirdGatewayUrlOutput789: 'https://third.url',
    };

    const gatewaySpecs = {
      'first-gateway': {},
      'second-gateway': {},
      'third-gateway': {},
    };

    const result = parseGatewayOutputs(outputs, gatewaySpecs);

    expect(Object.keys(result)).toHaveLength(3);
    expect(result['first-gateway']?.gatewayArn).toBe('https://first.url');
    expect(result['second-gateway']?.gatewayArn).toBe('https://second.url');
    expect(result['third-gateway']?.gatewayArn).toBe('https://third.url');
  });
});
