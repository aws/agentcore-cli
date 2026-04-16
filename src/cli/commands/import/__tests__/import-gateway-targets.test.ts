/**
 * Import Gateway Target Mapping Unit Tests
 *
 * Covers toGatewayTargetSpec for non-mcpServer target types:
 * - apiGateway: toolFilters, toolOverrides, outboundAuth
 * - openApiSchema: S3 URI mapping, missing URI warning
 * - smithyModel: S3 URI mapping, missing URI warning
 * - lambda: lambdaFunctionArn mapping, missing ARN, inline-only schema
 * - Unrecognized target type
 */
import type { GatewayTargetDetail } from '../../../aws/agentcore-control';
import { toGatewayTargetSpec } from '../import-gateway';
import { describe, expect, it, vi } from 'vitest';

/** Helper to build a minimal GatewayTargetDetail with only the fields under test. */
function baseDetail(overrides: Partial<GatewayTargetDetail> = {}): GatewayTargetDetail {
  return {
    targetId: 'tgt-001',
    name: 'test_target',
    status: 'READY',
    ...overrides,
  };
}

// ============================================================================
// apiGateway target
// ============================================================================

describe('toGatewayTargetSpec — apiGateway', () => {
  it('maps restApiId, stage, and toolFilters correctly', () => {
    const detail = baseDetail({
      targetConfiguration: {
        mcp: {
          apiGateway: {
            restApiId: 'abc123',
            stage: 'prod',
            apiGatewayToolConfiguration: {
              toolFilters: [
                { filterPath: '/pets', methods: ['GET', 'POST'] },
                { filterPath: '/users', methods: ['GET'] },
              ],
            },
          },
        },
      },
    });

    const onProgress = vi.fn();
    const result = toGatewayTargetSpec(detail, new Map(), onProgress);

    expect(result).toBeDefined();
    expect(result!.name).toBe('test_target');
    expect(result!.targetType).toBe('apiGateway');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const apigw = (result as any).apiGateway;
    expect(apigw.restApiId).toBe('abc123');
    expect(apigw.stage).toBe('prod');
    expect(apigw.apiGatewayToolConfiguration.toolFilters).toEqual([
      { filterPath: '/pets', methods: ['GET', 'POST'] },
      { filterPath: '/users', methods: ['GET'] },
    ]);
  });

  it('maps toolOverrides when present', () => {
    const detail = baseDetail({
      targetConfiguration: {
        mcp: {
          apiGateway: {
            restApiId: 'abc123',
            stage: 'prod',
            apiGatewayToolConfiguration: {
              toolFilters: [],
              toolOverrides: [
                { name: 'listPets', path: '/pets', method: 'GET', description: 'List all pets' },
                { name: 'createPet', path: '/pets', method: 'POST' },
              ],
            },
          },
        },
      },
    });

    const onProgress = vi.fn();
    const result = toGatewayTargetSpec(detail, new Map(), onProgress);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const apigw = (result as any).apiGateway;
    expect(apigw.apiGatewayToolConfiguration.toolOverrides).toEqual([
      { name: 'listPets', path: '/pets', method: 'GET', description: 'List all pets' },
      { name: 'createPet', path: '/pets', method: 'POST' },
    ]);
  });

  it('omits toolOverrides when not present', () => {
    const detail = baseDetail({
      targetConfiguration: {
        mcp: {
          apiGateway: {
            restApiId: 'abc123',
            stage: 'prod',
            apiGatewayToolConfiguration: {
              toolFilters: [{ filterPath: '/pets', methods: ['GET'] }],
            },
          },
        },
      },
    });

    const onProgress = vi.fn();
    const result = toGatewayTargetSpec(detail, new Map(), onProgress);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const apigw = (result as any).apiGateway;
    expect(apigw.apiGatewayToolConfiguration.toolOverrides).toBeUndefined();
  });

  it('returns outboundAuth when OAuth credential is configured', () => {
    const providerArn = 'arn:aws:bedrock-agentcore:us-west-2:123456789012:credential-provider/cred-001';
    const detail = baseDetail({
      targetConfiguration: {
        mcp: {
          apiGateway: {
            restApiId: 'abc123',
            stage: 'prod',
            apiGatewayToolConfiguration: { toolFilters: [] },
          },
        },
      },
      credentialProviderConfigurations: [
        {
          credentialProviderType: 'OAUTH',
          credentialProvider: {
            oauthCredentialProvider: {
              providerArn,
              scopes: ['read', 'write'],
            },
          },
        },
      ],
    });

    const credentials = new Map([[providerArn, 'my_oauth_cred']]);
    const onProgress = vi.fn();
    const result = toGatewayTargetSpec(detail, credentials, onProgress);

    expect(result).toBeDefined();
    expect(result!.outboundAuth).toEqual({
      type: 'OAUTH',
      credentialName: 'my_oauth_cred',
      scopes: ['read', 'write'],
    });
  });
});

// ============================================================================
// openApiSchema target
// ============================================================================

describe('toGatewayTargetSpec — openApiSchema', () => {
  it('maps S3 URI and bucketOwnerAccountId correctly', () => {
    const detail = baseDetail({
      targetConfiguration: {
        mcp: {
          openApiSchema: {
            s3: { uri: 's3://my-bucket/schema.yaml', bucketOwnerAccountId: '123456789012' },
          },
        },
      },
    });

    const onProgress = vi.fn();
    const result = toGatewayTargetSpec(detail, new Map(), onProgress);

    expect(result).toBeDefined();
    expect(result!.name).toBe('test_target');
    expect(result!.targetType).toBe('openApiSchema');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const schemaSource = (result as any).schemaSource;
    expect(schemaSource.s3.uri).toBe('s3://my-bucket/schema.yaml');
    expect(schemaSource.s3.bucketOwnerAccountId).toBe('123456789012');
  });

  it('returns undefined and emits warning when S3 URI is missing', () => {
    const detail = baseDetail({
      targetConfiguration: {
        mcp: {
          openApiSchema: { inlinePayload: '{"openapi":"3.0.0"}' },
        },
      },
    });

    const onProgress = vi.fn();
    const result = toGatewayTargetSpec(detail, new Map(), onProgress);

    expect(result).toBeUndefined();
    expect(onProgress).toHaveBeenCalledWith(expect.stringContaining('(openApiSchema) has no S3 URI, skipping'));
  });
});

// ============================================================================
// smithyModel target
// ============================================================================

describe('toGatewayTargetSpec — smithyModel', () => {
  it('maps S3 URI correctly', () => {
    const detail = baseDetail({
      targetConfiguration: {
        mcp: {
          smithyModel: {
            s3: { uri: 's3://models-bucket/model.json' },
          },
        },
      },
    });

    const onProgress = vi.fn();
    const result = toGatewayTargetSpec(detail, new Map(), onProgress);

    expect(result).toBeDefined();
    expect(result!.name).toBe('test_target');
    expect(result!.targetType).toBe('smithyModel');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const schemaSource = (result as any).schemaSource;
    expect(schemaSource.s3.uri).toBe('s3://models-bucket/model.json');
    expect(schemaSource.s3.bucketOwnerAccountId).toBeUndefined();
  });

  it('returns undefined and emits warning when S3 URI is missing', () => {
    const detail = baseDetail({
      targetConfiguration: {
        mcp: {
          smithyModel: { inlinePayload: '{"smithy":"1.0"}' },
        },
      },
    });

    const onProgress = vi.fn();
    const result = toGatewayTargetSpec(detail, new Map(), onProgress);

    expect(result).toBeUndefined();
    expect(onProgress).toHaveBeenCalledWith(expect.stringContaining('(smithyModel) has no S3 URI, skipping'));
  });
});

// ============================================================================
// lambda target
// ============================================================================

describe('toGatewayTargetSpec — lambda', () => {
  it('maps lambda with S3 tool schema to lambdaFunctionArn type', () => {
    const detail = baseDetail({
      targetConfiguration: {
        mcp: {
          lambda: {
            lambdaArn: 'arn:aws:lambda:us-west-2:123456789012:function:my-func',
            toolSchema: { s3: { uri: 's3://schemas/tools.json' } },
          },
        },
      },
    });

    const onProgress = vi.fn();
    const result = toGatewayTargetSpec(detail, new Map(), onProgress);

    expect(result).toBeDefined();
    expect(result!.name).toBe('test_target');
    expect(result!.targetType).toBe('lambdaFunctionArn');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lambdaConfig = (result as any).lambdaFunctionArn;
    expect(lambdaConfig.lambdaArn).toBe('arn:aws:lambda:us-west-2:123456789012:function:my-func');
    expect(lambdaConfig.toolSchemaFile).toBe('s3://schemas/tools.json');
  });

  it('returns undefined and emits warning when lambdaArn is missing', () => {
    const detail = baseDetail({
      targetConfiguration: {
        mcp: {
          lambda: {
            lambdaArn: '',
            toolSchema: { s3: { uri: 's3://schemas/tools.json' } },
          },
        },
      },
    });

    const onProgress = vi.fn();
    const result = toGatewayTargetSpec(detail, new Map(), onProgress);

    expect(result).toBeUndefined();
    expect(onProgress).toHaveBeenCalledWith(expect.stringContaining('(lambda) has no ARN, skipping'));
  });

  it('returns undefined and emits warning when lambda has inline schema only', () => {
    const detail = baseDetail({
      targetConfiguration: {
        mcp: {
          lambda: {
            lambdaArn: 'arn:aws:lambda:us-west-2:123456789012:function:my-func',
            toolSchema: { inlinePayload: '{"tools":[]}' },
          },
        },
      },
    });

    const onProgress = vi.fn();
    const result = toGatewayTargetSpec(detail, new Map(), onProgress);

    expect(result).toBeUndefined();
    expect(onProgress).toHaveBeenCalledWith(
      expect.stringContaining('has inline tool schema, which cannot be imported')
    );
  });

  it('emits progress message for successful lambda mapping', () => {
    const detail = baseDetail({
      targetConfiguration: {
        mcp: {
          lambda: {
            lambdaArn: 'arn:aws:lambda:us-west-2:123456789012:function:my-func',
            toolSchema: { s3: { uri: 's3://schemas/tools.json' } },
          },
        },
      },
    });

    const onProgress = vi.fn();
    toGatewayTargetSpec(detail, new Map(), onProgress);

    expect(onProgress).toHaveBeenCalledWith(expect.stringContaining('Mapping compute-backed Lambda target'));
  });
});

// ============================================================================
// Unrecognized target type
// ============================================================================

describe('toGatewayTargetSpec — unrecognized target type', () => {
  it('returns undefined and emits warning when no known mcp type matches', () => {
    const detail = baseDetail({
      targetConfiguration: {
        mcp: {},
      },
    });

    const onProgress = vi.fn();
    const result = toGatewayTargetSpec(detail, new Map(), onProgress);

    expect(result).toBeUndefined();
    expect(onProgress).toHaveBeenCalledWith(expect.stringContaining('unrecognized target type'));
  });
});
