import { buildDeployedState } from '../outputs';
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
      undefined,
      'arn:aws:kms:us-east-1:123456789012:key/abc-123'
    );

    expect(result.targets.default?.resources?.identityKmsKeyArn).toBe('arn:aws:kms:us-east-1:123456789012:key/abc-123');
  });

  it('omits identityKmsKeyArn when not provided', () => {
    const agents = {
      TestAgent: {
        runtimeId: 'rt-123',
        runtimeArn: 'arn:aws:bedrock:us-east-1:123456789012:agent-runtime/rt-123',
        roleArn: 'arn:aws:iam::123456789012:role/TestRole',
      },
    };

    const result = buildDeployedState('default', 'TestStack', agents);

    expect(result.targets.default?.resources?.identityKmsKeyArn).toBeUndefined();
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
      existingState,
      'arn:aws:kms:us-east-1:123456789012:key/dev-key'
    );

    expect(result.targets.prod?.resources?.stackName).toBe('ProdStack');
    expect(result.targets.dev?.resources?.identityKmsKeyArn).toBe('arn:aws:kms:us-east-1:123456789012:key/dev-key');
  });
});
