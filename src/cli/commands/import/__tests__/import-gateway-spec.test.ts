/**
 * toGatewaySpec Unit Tests
 *
 * Covers gateway-level field mapping from AWS GetGateway response
 * to CLI AgentCoreGateway schema:
 * - Authorizer type mapping (NONE, AWS_IAM, CUSTOM_JWT with claims, empty arrays)
 * - Semantic search configuration
 * - Exception level mapping
 * - Policy engine configuration
 * - Description, tags, resourceName, executionRoleArn
 */
import type { AgentCoreGatewayTarget } from '../../../../schema';
import type { GatewayDetail } from '../../../aws/agentcore-control';
import { toGatewaySpec } from '../import-gateway';
import { describe, expect, it } from 'vitest';

/** Helper to build a minimal GatewayDetail for tests. */
function makeGateway(overrides: Partial<GatewayDetail> = {}): GatewayDetail {
  return {
    gatewayId: 'gw-test-001',
    gatewayArn: 'arn:aws:bedrock-agentcore:us-west-2:123456789012:gateway/gw-test-001',
    name: 'TestGateway',
    status: 'READY',
    authorizerType: 'NONE',
    ...overrides,
  };
}

const emptyTargets: AgentCoreGatewayTarget[] = [];

// ============================================================================
// Authorizer Type Mapping
// ============================================================================

describe('toGatewaySpec – authorizer type mapping', () => {
  it('NONE authorizerType: no authorizerConfiguration in output', () => {
    const gw = makeGateway({ authorizerType: 'NONE' });
    const result = toGatewaySpec(gw, emptyTargets, 'my_gw');

    expect(result.authorizerType).toBe('NONE');
    expect(result).not.toHaveProperty('authorizerConfiguration');
  });

  it('AWS_IAM authorizerType: maps to AWS_IAM, no authorizerConfiguration', () => {
    const gw = makeGateway({ authorizerType: 'AWS_IAM' });
    const result = toGatewaySpec(gw, emptyTargets, 'my_gw');

    expect(result.authorizerType).toBe('AWS_IAM');
    expect(result).not.toHaveProperty('authorizerConfiguration');
  });

  it('CUSTOM_JWT basic: maps discoveryUrl, allowedAudience, allowedClients, allowedScopes', () => {
    const gw = makeGateway({
      authorizerType: 'CUSTOM_JWT',
      authorizerConfiguration: {
        customJwtAuthorizer: {
          discoveryUrl: 'https://example.com/.well-known/openid-configuration',
          allowedAudience: ['aud1', 'aud2'],
          allowedClients: ['client1'],
          allowedScopes: ['read', 'write'],
        },
      },
    });
    const result = toGatewaySpec(gw, emptyTargets, 'my_gw');

    expect(result.authorizerType).toBe('CUSTOM_JWT');
    expect(result.authorizerConfiguration).toBeDefined();
    const jwt = result.authorizerConfiguration!.customJwtAuthorizer!;
    expect(jwt.discoveryUrl).toBe('https://example.com/.well-known/openid-configuration');
    expect(jwt.allowedAudience).toEqual(['aud1', 'aud2']);
    expect(jwt.allowedClients).toEqual(['client1']);
    expect(jwt.allowedScopes).toEqual(['read', 'write']);
  });

  it('CUSTOM_JWT with customClaims: maps full claim structure', () => {
    const gw = makeGateway({
      authorizerType: 'CUSTOM_JWT',
      authorizerConfiguration: {
        customJwtAuthorizer: {
          discoveryUrl: 'https://example.com/.well-known/openid-configuration',
          allowedAudience: ['aud1'],
          customClaims: [
            {
              inboundTokenClaimName: 'department',
              inboundTokenClaimValueType: 'STRING',
              authorizingClaimMatchValue: {
                claimMatchOperator: 'EQUALS',
                claimMatchValue: { matchValueString: 'engineering' },
              },
            },
            {
              inboundTokenClaimName: 'roles',
              inboundTokenClaimValueType: 'STRING_ARRAY',
              authorizingClaimMatchValue: {
                claimMatchOperator: 'CONTAINS_ANY',
                claimMatchValue: { matchValueStringList: ['admin', 'editor'] },
              },
            },
          ],
        },
      },
    });
    const result = toGatewaySpec(gw, emptyTargets, 'my_gw');

    const claims = result.authorizerConfiguration!.customJwtAuthorizer!.customClaims!;
    expect(claims).toHaveLength(2);

    expect(claims[0]!.inboundTokenClaimName).toBe('department');
    expect(claims[0]!.inboundTokenClaimValueType).toBe('STRING');
    expect(claims[0]!.authorizingClaimMatchValue.claimMatchOperator).toBe('EQUALS');
    expect(claims[0]!.authorizingClaimMatchValue.claimMatchValue.matchValueString).toBe('engineering');
    expect(claims[0]!.authorizingClaimMatchValue.claimMatchValue).not.toHaveProperty('matchValueStringList');

    expect(claims[1]!.inboundTokenClaimName).toBe('roles');
    expect(claims[1]!.inboundTokenClaimValueType).toBe('STRING_ARRAY');
    expect(claims[1]!.authorizingClaimMatchValue.claimMatchOperator).toBe('CONTAINS_ANY');
    expect(claims[1]!.authorizingClaimMatchValue.claimMatchValue.matchValueStringList).toEqual(['admin', 'editor']);
    expect(claims[1]!.authorizingClaimMatchValue.claimMatchValue).not.toHaveProperty('matchValueString');
  });

  it('CUSTOM_JWT with empty arrays: allowedAudience=[], allowedClients=[] are omitted', () => {
    const gw = makeGateway({
      authorizerType: 'CUSTOM_JWT',
      authorizerConfiguration: {
        customJwtAuthorizer: {
          discoveryUrl: 'https://example.com/.well-known/openid-configuration',
          allowedAudience: [],
          allowedClients: [],
          allowedScopes: ['openid'],
        },
      },
    });
    const result = toGatewaySpec(gw, emptyTargets, 'my_gw');

    const jwt = result.authorizerConfiguration!.customJwtAuthorizer!;
    expect(jwt).not.toHaveProperty('allowedAudience');
    expect(jwt).not.toHaveProperty('allowedClients');
    expect(jwt.allowedScopes).toEqual(['openid']);
  });

  it('missing authorizerType: defaults to NONE', () => {
    const gw = makeGateway();
    // Simulate undefined authorizerType by deleting after construction
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (gw as any).authorizerType;
    const result = toGatewaySpec(gw, emptyTargets, 'my_gw');

    expect(result.authorizerType).toBe('NONE');
    expect(result).not.toHaveProperty('authorizerConfiguration');
  });
});

// ============================================================================
// Semantic Search
// ============================================================================

describe('toGatewaySpec – semantic search', () => {
  it('searchType=SEMANTIC: enableSemanticSearch is true', () => {
    const gw = makeGateway({
      protocolConfiguration: { mcp: { searchType: 'SEMANTIC' } },
    });
    const result = toGatewaySpec(gw, emptyTargets, 'my_gw');

    expect(result.enableSemanticSearch).toBe(true);
  });

  it('searchType=KEYWORD: enableSemanticSearch is false', () => {
    const gw = makeGateway({
      protocolConfiguration: { mcp: { searchType: 'KEYWORD' } },
    });
    const result = toGatewaySpec(gw, emptyTargets, 'my_gw');

    expect(result.enableSemanticSearch).toBe(false);
  });

  it('protocolConfiguration missing: enableSemanticSearch is false', () => {
    const gw = makeGateway();
    const result = toGatewaySpec(gw, emptyTargets, 'my_gw');

    expect(result.enableSemanticSearch).toBe(false);
  });
});

// ============================================================================
// Exception Level
// ============================================================================

describe('toGatewaySpec – exception level', () => {
  it('exceptionLevel=DEBUG: maps to DEBUG', () => {
    const gw = makeGateway({ exceptionLevel: 'DEBUG' });
    const result = toGatewaySpec(gw, emptyTargets, 'my_gw');

    expect(result.exceptionLevel).toBe('DEBUG');
  });

  it('exceptionLevel undefined: maps to NONE', () => {
    const gw = makeGateway({ exceptionLevel: undefined });
    const result = toGatewaySpec(gw, emptyTargets, 'my_gw');

    expect(result.exceptionLevel).toBe('NONE');
  });

  it('exceptionLevel other value: maps to NONE', () => {
    const gw = makeGateway({ exceptionLevel: 'VERBOSE' });
    const result = toGatewaySpec(gw, emptyTargets, 'my_gw');

    expect(result.exceptionLevel).toBe('NONE');
  });
});

// ============================================================================
// Policy Engine
// ============================================================================

describe('toGatewaySpec – policy engine', () => {
  it('policyEngineConfiguration present: extracts name from ARN last segment, preserves mode', () => {
    const gw = makeGateway({
      policyEngineConfiguration: {
        arn: 'arn:aws:bedrock-agentcore:us-west-2:123456789012:policy-engine/my_policy_engine',
        mode: 'ENFORCE',
      },
    });
    const result = toGatewaySpec(gw, emptyTargets, 'my_gw');

    expect(result.policyEngineConfiguration).toBeDefined();
    expect(result.policyEngineConfiguration!.policyEngineName).toBe('my_policy_engine');
    expect(result.policyEngineConfiguration!.mode).toBe('ENFORCE');
  });

  it('policyEngineConfiguration absent: field omitted', () => {
    const gw = makeGateway();
    const result = toGatewaySpec(gw, emptyTargets, 'my_gw');

    expect(result).not.toHaveProperty('policyEngineConfiguration');
  });
});

// ============================================================================
// Other Fields
// ============================================================================

describe('toGatewaySpec – other fields', () => {
  it('resourceName is always set to gateway.name', () => {
    const gw = makeGateway({ name: 'AwsGatewayName' });
    const result = toGatewaySpec(gw, emptyTargets, 'local_name');

    expect(result.resourceName).toBe('AwsGatewayName');
    expect(result.name).toBe('local_name');
  });

  it('description present: included in output', () => {
    const gw = makeGateway({ description: 'My gateway description' });
    const result = toGatewaySpec(gw, emptyTargets, 'my_gw');

    expect(result.description).toBe('My gateway description');
  });

  it('description undefined: omitted from output', () => {
    const gw = makeGateway({ description: undefined });
    const result = toGatewaySpec(gw, emptyTargets, 'my_gw');

    expect(result).not.toHaveProperty('description');
  });

  it('tags present with entries: included in output', () => {
    const gw = makeGateway({ tags: { env: 'prod', team: 'platform' } });
    const result = toGatewaySpec(gw, emptyTargets, 'my_gw');

    expect(result.tags).toEqual({ env: 'prod', team: 'platform' });
  });

  it('tags empty object: omitted from output', () => {
    const gw = makeGateway({ tags: {} });
    const result = toGatewaySpec(gw, emptyTargets, 'my_gw');

    expect(result).not.toHaveProperty('tags');
  });

  it('tags undefined: omitted from output', () => {
    const gw = makeGateway({ tags: undefined });
    const result = toGatewaySpec(gw, emptyTargets, 'my_gw');

    expect(result).not.toHaveProperty('tags');
  });

  it('executionRoleArn: mapped from gateway.roleArn', () => {
    const gw = makeGateway({ roleArn: 'arn:aws:iam::123456789012:role/GatewayRole' });
    const result = toGatewaySpec(gw, emptyTargets, 'my_gw');

    expect(result.executionRoleArn).toBe('arn:aws:iam::123456789012:role/GatewayRole');
  });

  it('roleArn undefined: executionRoleArn omitted from output', () => {
    const gw = makeGateway({ roleArn: undefined });
    const result = toGatewaySpec(gw, emptyTargets, 'my_gw');

    expect(result).not.toHaveProperty('executionRoleArn');
  });

  it('targets are passed through to output', () => {
    const targets: AgentCoreGatewayTarget[] = [
      { name: 'target1', targetType: 'mcpServer', endpoint: 'https://mcp.example.com' },
    ];
    const gw = makeGateway();
    const result = toGatewaySpec(gw, targets, 'my_gw');

    expect(result.targets).toBe(targets);
    expect(result.targets).toHaveLength(1);
    expect(result.targets[0]!.name).toBe('target1');
  });
});
