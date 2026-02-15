import {
  AgentCoreDeployedStateSchema,
  CustomJwtAuthorizerSchema,
  DeployedResourceStateSchema,
  DeployedStateSchema,
  GatewayDeployedStateSchema,
  McpDeployedStateSchema,
  McpLambdaDeployedStateSchema,
  McpRuntimeDeployedStateSchema,
  VpcConfigSchema,
  createValidatedDeployedStateSchema,
} from '../deployed-state.js';
import { describe, expect, it } from 'vitest';

describe('AgentCoreDeployedStateSchema', () => {
  it('accepts minimal valid state', () => {
    const result = AgentCoreDeployedStateSchema.safeParse({
      runtimeId: 'rt-123',
      runtimeArn: 'arn:aws:bedrock:us-east-1:123:agent-runtime/rt-123',
      roleArn: 'arn:aws:iam::123:role/TestRole',
    });
    expect(result.success).toBe(true);
  });

  it('accepts state with all optional fields', () => {
    const result = AgentCoreDeployedStateSchema.safeParse({
      runtimeId: 'rt-123',
      runtimeArn: 'arn:aws:bedrock:us-east-1:123:agent-runtime/rt-123',
      roleArn: 'arn:aws:iam::123:role/TestRole',
      sessionId: 'sess-abc',
      memoryIds: ['mem-1', 'mem-2'],
      browserId: 'browser-1',
      codeInterpreterId: 'ci-1',
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty runtimeId', () => {
    expect(
      AgentCoreDeployedStateSchema.safeParse({
        runtimeId: '',
        runtimeArn: 'arn:valid',
        roleArn: 'arn:valid',
      }).success
    ).toBe(false);
  });

  it('rejects missing required fields', () => {
    expect(AgentCoreDeployedStateSchema.safeParse({ runtimeId: 'rt-123' }).success).toBe(false);
  });
});

describe('GatewayDeployedStateSchema', () => {
  it('accepts valid gateway state', () => {
    expect(
      GatewayDeployedStateSchema.safeParse({
        gatewayId: 'gw-123',
        gatewayArn: 'arn:aws:gateway/gw-123',
      }).success
    ).toBe(true);
  });

  it('rejects empty gatewayId', () => {
    expect(
      GatewayDeployedStateSchema.safeParse({
        gatewayId: '',
        gatewayArn: 'arn:valid',
      }).success
    ).toBe(false);
  });
});

describe('McpRuntimeDeployedStateSchema', () => {
  it('accepts valid runtime state', () => {
    expect(
      McpRuntimeDeployedStateSchema.safeParse({
        runtimeId: 'rt-123',
        runtimeArn: 'arn:aws:runtime/rt-123',
        runtimeEndpoint: 'https://endpoint.example.com',
      }).success
    ).toBe(true);
  });
});

describe('McpLambdaDeployedStateSchema', () => {
  it('accepts valid lambda state', () => {
    expect(
      McpLambdaDeployedStateSchema.safeParse({
        functionArn: 'arn:aws:lambda:us-east-1:123:function:my-func',
        functionName: 'my-func',
      }).success
    ).toBe(true);
  });
});

describe('McpDeployedStateSchema', () => {
  it('accepts empty MCP state', () => {
    expect(McpDeployedStateSchema.safeParse({}).success).toBe(true);
  });

  it('accepts full MCP state', () => {
    const result = McpDeployedStateSchema.safeParse({
      gateways: {
        myGateway: { gatewayId: 'gw-1', gatewayArn: 'arn:gw-1' },
      },
      runtimes: {
        myRuntime: { runtimeId: 'rt-1', runtimeArn: 'arn:rt-1', runtimeEndpoint: 'https://endpoint' },
      },
      lambdas: {
        myLambda: { functionArn: 'arn:lambda', functionName: 'func' },
      },
    });
    expect(result.success).toBe(true);
  });
});

describe('CustomJwtAuthorizerSchema', () => {
  it('accepts valid JWT authorizer', () => {
    const result = CustomJwtAuthorizerSchema.safeParse({
      name: 'my-authorizer',
      allowedAudience: ['client-1'],
      allowedClients: ['client-1'],
      discoveryUrl: 'https://example.com/.well-known/openid-configuration',
    });
    expect(result.success).toBe(true);
  });
});

describe('VpcConfigSchema', () => {
  it('accepts valid VPC config', () => {
    const result = VpcConfigSchema.safeParse({
      name: 'my-vpc',
      securityGroups: ['sg-123'],
      subnets: ['subnet-abc'],
    });
    expect(result.success).toBe(true);
  });
});

describe('DeployedResourceStateSchema', () => {
  it('accepts empty resource state', () => {
    expect(DeployedResourceStateSchema.safeParse({}).success).toBe(true);
  });

  it('accepts resource state with agents', () => {
    const result = DeployedResourceStateSchema.safeParse({
      agents: {
        MyAgent: {
          runtimeId: 'rt-123',
          runtimeArn: 'arn:rt',
          roleArn: 'arn:role',
        },
      },
      stackName: 'TestStack',
    });
    expect(result.success).toBe(true);
  });

  it('accepts resource state with identityKmsKeyArn', () => {
    const result = DeployedResourceStateSchema.safeParse({
      identityKmsKeyArn: 'arn:aws:kms:us-east-1:123:key/abc',
    });
    expect(result.success).toBe(true);
  });
});

describe('DeployedStateSchema', () => {
  it('accepts valid deployed state with targets', () => {
    const result = DeployedStateSchema.safeParse({
      targets: {
        default: {
          resources: {
            agents: {},
            stackName: 'TestStack',
          },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts state with multiple targets', () => {
    const result = DeployedStateSchema.safeParse({
      targets: {
        dev: { resources: {} },
        prod: { resources: {} },
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts empty targets', () => {
    const result = DeployedStateSchema.safeParse({ targets: {} });
    expect(result.success).toBe(true);
  });
});

describe('createValidatedDeployedStateSchema', () => {
  it('accepts state with targets matching known target names', () => {
    const schema = createValidatedDeployedStateSchema(['dev', 'prod']);
    const result = schema.safeParse({
      targets: {
        dev: { resources: {} },
        prod: { resources: {} },
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts state with subset of known target names', () => {
    const schema = createValidatedDeployedStateSchema(['dev', 'prod', 'staging']);
    const result = schema.safeParse({
      targets: {
        dev: { resources: {} },
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects state with unknown target names', () => {
    const schema = createValidatedDeployedStateSchema(['dev', 'prod']);
    const result = schema.safeParse({
      targets: {
        unknown: { resources: {} },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.message.includes('not present in aws-targets'))).toBe(true);
    }
  });

  it('accepts empty targets regardless of known names', () => {
    const schema = createValidatedDeployedStateSchema(['dev']);
    const result = schema.safeParse({ targets: {} });
    expect(result.success).toBe(true);
  });
});
