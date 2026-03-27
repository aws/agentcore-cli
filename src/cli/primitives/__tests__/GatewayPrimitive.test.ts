import type { AgentCoreProjectSpec } from '../../../schema';
import { GatewayPrimitive } from '../GatewayPrimitive';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const defaultProject: AgentCoreProjectSpec = {
  name: 'test',
  version: 1,
  managedBy: 'CDK' as const,
  runtimes: [],
  memories: [],
  credentials: [],
  evaluators: [],
  onlineEvalConfigs: [],
  agentCoreGateways: [],
  policyEngines: [],
};

const { mockConfigExists, mockReadProjectSpec, mockWriteProjectSpec } = vi.hoisted(() => ({
  mockConfigExists: vi.fn().mockReturnValue(true),
  mockReadProjectSpec: vi.fn(),
  mockWriteProjectSpec: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../lib', () => {
  const MockConfigIO = vi.fn(function (this: Record<string, unknown>) {
    this.configExists = mockConfigExists;
    this.readProjectSpec = mockReadProjectSpec;
    this.writeProjectSpec = mockWriteProjectSpec;
  });
  return {
    ConfigIO: MockConfigIO,
    findConfigRoot: vi.fn().mockReturnValue('/fake/root'),
    setEnvVar: vi.fn().mockResolvedValue(undefined),
  };
});

/** Extract the first gateway written to writeProjectSpec. */
function getWrittenGateway() {
  expect(mockWriteProjectSpec).toHaveBeenCalledTimes(1);
  const spec = mockWriteProjectSpec.mock.calls[0]![0] as AgentCoreProjectSpec;
  const gw = spec.agentCoreGateways[0];
  expect(gw).toBeDefined();
  return gw!;
}

describe('GatewayPrimitive', () => {
  let primitive: GatewayPrimitive;

  beforeEach(() => {
    vi.clearAllMocks();
    mockReadProjectSpec.mockImplementation(() => Promise.resolve({ ...defaultProject, agentCoreGateways: [] }));
    primitive = new GatewayPrimitive();
  });

  describe('customClaims pipeline', () => {
    const SAMPLE_CLAIMS = [
      {
        inboundTokenClaimName: 'department',
        inboundTokenClaimValueType: 'STRING_ARRAY' as const,
        authorizingClaimMatchValue: {
          claimMatchOperator: 'CONTAINS_ANY' as const,
          claimMatchValue: { matchValueStringList: ['engineering', 'sales'] },
        },
      },
    ];

    it('custom claims from TUI flow are written to authorizerConfiguration', async () => {
      await primitive.add({
        name: 'jwt-gw',
        authorizerType: 'CUSTOM_JWT',
        discoveryUrl: 'https://example.com/.well-known/openid-configuration',
        allowedAudience: 'aud1',
        customClaims: SAMPLE_CLAIMS,
      });

      const gw = getWrittenGateway();
      expect(gw.authorizerConfiguration?.customJwtAuthorizer).toBeDefined();
      expect(gw.authorizerConfiguration!.customJwtAuthorizer!.customClaims).toEqual(SAMPLE_CLAIMS);
    });

    it('custom claims are preserved alongside audience and clients', async () => {
      await primitive.add({
        name: 'jwt-gw',
        authorizerType: 'CUSTOM_JWT',
        discoveryUrl: 'https://example.com/.well-known/openid-configuration',
        allowedAudience: 'aud1,aud2',
        allowedClients: 'client1',
        customClaims: SAMPLE_CLAIMS,
      });

      const gw = getWrittenGateway();
      const jwtConfig = gw.authorizerConfiguration!.customJwtAuthorizer!;
      expect(jwtConfig.allowedAudience).toEqual(['aud1', 'aud2']);
      expect(jwtConfig.allowedClients).toEqual(['client1']);
      expect(jwtConfig.customClaims).toEqual(SAMPLE_CLAIMS);
    });

    it('omits customClaims from authorizerConfiguration when not provided', async () => {
      await primitive.add({
        name: 'jwt-gw',
        authorizerType: 'CUSTOM_JWT',
        discoveryUrl: 'https://example.com/.well-known/openid-configuration',
        allowedAudience: 'aud1',
      });

      const gw = getWrittenGateway();
      expect(gw.authorizerConfiguration!.customJwtAuthorizer!.customClaims).toBeUndefined();
    });

    it('custom claims only (no audience/clients/scopes) produces valid config', async () => {
      await primitive.add({
        name: 'jwt-gw',
        authorizerType: 'CUSTOM_JWT',
        discoveryUrl: 'https://example.com/.well-known/openid-configuration',
        customClaims: SAMPLE_CLAIMS,
      });

      const gw = getWrittenGateway();
      const jwtConfig = gw.authorizerConfiguration!.customJwtAuthorizer!;
      expect(jwtConfig.allowedAudience).toBeUndefined();
      expect(jwtConfig.allowedClients).toBeUndefined();
      expect(jwtConfig.allowedScopes).toBeUndefined();
      expect(jwtConfig.customClaims).toEqual(SAMPLE_CLAIMS);
    });
  });

  describe('exceptionLevel', () => {
    it('defaults to exceptionLevel NONE', async () => {
      await primitive.add({ name: 'test-gw', authorizerType: 'NONE' });

      const gw = getWrittenGateway();
      expect(gw.exceptionLevel).toBe('NONE');
    });

    it('exceptionLevel DEBUG passes through', async () => {
      await primitive.add({ name: 'test-gw', authorizerType: 'NONE', exceptionLevel: 'DEBUG' });

      const gw = getWrittenGateway();
      expect(gw.exceptionLevel).toBe('DEBUG');
    });

    it('invalid exceptionLevel falls back to NONE', async () => {
      await primitive.add({ name: 'test-gw', authorizerType: 'NONE', exceptionLevel: 'VERBOSE' });

      const gw = getWrittenGateway();
      expect(gw.exceptionLevel).toBe('NONE');
    });
  });
});
