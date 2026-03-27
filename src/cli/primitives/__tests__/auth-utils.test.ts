import type { AgentCoreProjectSpec, CustomClaimValidation } from '../../../schema';
import { buildAuthorizerConfigFromJwtConfig, createManagedOAuthCredential } from '../auth-utils';
import type { JwtConfigOptions } from '../auth-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSetEnvVar } = vi.hoisted(() => ({
  mockSetEnvVar: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../lib', () => ({
  setEnvVar: mockSetEnvVar,
}));

describe('buildAuthorizerConfigFromJwtConfig', () => {
  it('returns correct nested structure with all fields', () => {
    const customClaim: CustomClaimValidation = {
      inboundTokenClaimName: 'department',
      inboundTokenClaimValueType: 'STRING',
      authorizingClaimMatchValue: {
        claimMatchOperator: 'EQUALS',
        claimMatchValue: { matchValueString: 'engineering' },
      },
    };

    const result = buildAuthorizerConfigFromJwtConfig({
      discoveryUrl: 'https://example.com/.well-known/openid-configuration',
      allowedAudience: ['aud1', 'aud2'],
      allowedClients: ['client1'],
      allowedScopes: ['scope1', 'scope2'],
      customClaims: [customClaim],
    });

    expect(result).toEqual({
      customJwtAuthorizer: {
        discoveryUrl: 'https://example.com/.well-known/openid-configuration',
        allowedAudience: ['aud1', 'aud2'],
        allowedClients: ['client1'],
        allowedScopes: ['scope1', 'scope2'],
        customClaims: [customClaim],
      },
    });
  });

  it('omits empty/undefined optional arrays', () => {
    const result = buildAuthorizerConfigFromJwtConfig({
      discoveryUrl: 'https://example.com/.well-known/openid-configuration',
      allowedAudience: [],
      allowedClients: undefined,
      allowedScopes: [],
    });

    expect(result).toEqual({
      customJwtAuthorizer: {
        discoveryUrl: 'https://example.com/.well-known/openid-configuration',
      },
    });
    expect(result.customJwtAuthorizer).not.toHaveProperty('allowedAudience');
    expect(result.customJwtAuthorizer).not.toHaveProperty('allowedClients');
    expect(result.customJwtAuthorizer).not.toHaveProperty('allowedScopes');
    expect(result.customJwtAuthorizer).not.toHaveProperty('customClaims');
  });

  it('includes custom claims when provided', () => {
    const claims: CustomClaimValidation[] = [
      {
        inboundTokenClaimName: 'role',
        inboundTokenClaimValueType: 'STRING_ARRAY',
        authorizingClaimMatchValue: {
          claimMatchOperator: 'CONTAINS',
          claimMatchValue: { matchValueStringList: ['admin', 'editor'] },
        },
      },
    ];

    const result = buildAuthorizerConfigFromJwtConfig({
      discoveryUrl: 'https://idp.example.com/.well-known/openid-configuration',
      customClaims: claims,
    });

    expect(result.customJwtAuthorizer.customClaims).toEqual(claims);
  });
});

describe('createManagedOAuthCredential', () => {
  const baseProject: AgentCoreProjectSpec = {
    name: 'test',
    version: 1,
    managedBy: 'CDK' as const,
    agents: [],
    memories: [],
    credentials: [],
    evaluators: [],
    onlineEvalConfigs: [],
    agentCoreGateways: [],
    policyEngines: [],
  };

  const jwtConfig: JwtConfigOptions = {
    discoveryUrl: 'https://idp.example.com/.well-known/openid-configuration',
    clientId: 'id1',
    clientSecret: 'secret1',
  };

  let writeSpy: ReturnType<typeof vi.fn>;
  let readSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    writeSpy = vi.fn().mockResolvedValue(undefined);
    readSpy = vi.fn().mockResolvedValue({ ...baseProject, credentials: [] });
  });

  it('creates credential with correct name/type/vendor/managed/usage fields', async () => {
    await createManagedOAuthCredential('my-gateway', jwtConfig, writeSpy as never, readSpy as never);

    expect(writeSpy).toHaveBeenCalledTimes(1);
    const writtenSpec = writeSpy.mock.calls[0]![0] as AgentCoreProjectSpec;
    const cred = writtenSpec.credentials.find(c => c.name === 'my-gateway-oauth');
    expect(cred).toEqual({
      type: 'OAuthCredentialProvider',
      name: 'my-gateway-oauth',
      discoveryUrl: 'https://idp.example.com/.well-known/openid-configuration',
      vendor: 'CustomOauth2',
      managed: true,
      usage: 'inbound',
    });
  });

  it('writes client ID and secret to .env', async () => {
    const config: JwtConfigOptions = {
      discoveryUrl: 'https://idp.example.com/.well-known/openid-configuration',
      clientId: 'myClientId',
      clientSecret: 'mySecret',
    };
    await createManagedOAuthCredential('my-gateway', config, writeSpy as never, readSpy as never);

    expect(mockSetEnvVar).toHaveBeenCalledWith('AGENTCORE_CREDENTIAL_MY_GATEWAY_OAUTH_CLIENT_ID', 'myClientId');
    expect(mockSetEnvVar).toHaveBeenCalledWith('AGENTCORE_CREDENTIAL_MY_GATEWAY_OAUTH_CLIENT_SECRET', 'mySecret');
  });

  it('skips creation if credential already exists', async () => {
    readSpy.mockResolvedValue({
      ...baseProject,
      credentials: [
        {
          type: 'OAuthCredentialProvider',
          name: 'my-gateway-oauth',
          discoveryUrl: 'https://idp.example.com/.well-known/openid-configuration',
          vendor: 'CustomOauth2',
          managed: true,
          usage: 'inbound',
        },
      ],
    });

    await createManagedOAuthCredential('my-gateway', jwtConfig, writeSpy as never, readSpy as never);

    expect(writeSpy).not.toHaveBeenCalled();
    expect(mockSetEnvVar).not.toHaveBeenCalled();
  });
});
