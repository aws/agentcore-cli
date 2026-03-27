import { readEnvFile } from '../../../../lib/utils/env';
import { fetchGatewayToken } from '../fetch-gateway-token';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../lib/index.js', () => ({
  ConfigIO: vi.fn(),
}));

vi.mock('../../../../lib/utils/env', () => ({
  readEnvFile: vi.fn(),
}));

const GATEWAY_URL = 'https://gw.example.com';
const DISCOVERY_URL = 'https://idp.example.com/.well-known/openid-configuration';
const TOKEN_ENDPOINT = 'https://idp.example.com/token';

const defaultDeployedState = {
  targets: {
    default: {
      resources: {
        mcp: {
          gateways: {
            myGateway: {
              gatewayId: 'gw-123',
              gatewayArn: 'arn:aws:bedrock:us-east-1:123456789012:gateway/gw-123',
              gatewayUrl: GATEWAY_URL,
            },
          },
        },
      },
    },
  },
};

const baseProjectSpec = {
  name: 'test',
  version: 1,
  credentials: [
    {
      authorizerType: 'OAuthCredentialProvider',
      name: 'myGateway-oauth',
      discoveryUrl: DISCOVERY_URL,
    },
  ],
  agents: [],
  memories: [],
  evaluators: [],
  onlineEvalConfigs: [],
};

const defaultProjectSpecNone = {
  ...baseProjectSpec,
  agentCoreGateways: [
    {
      name: 'myGateway',
      targets: [],
      authorizerType: 'NONE',
    },
  ],
};

const defaultProjectSpecAwsIam = {
  ...baseProjectSpec,
  agentCoreGateways: [
    {
      name: 'myGateway',
      targets: [],
      authorizerType: 'AWS_IAM',
    },
  ],
};

const defaultProjectSpecCustomJwt = {
  ...baseProjectSpec,
  agentCoreGateways: [
    {
      name: 'myGateway',
      targets: [],
      authorizerType: 'CUSTOM_JWT',
      authorizerConfiguration: {
        customJwtAuthorizer: {
          discoveryUrl: DISCOVERY_URL,
          allowedClients: ['fallback-client'],
          allowedScopes: ['openid', 'profile'],
        },
      },
    },
  ],
};

function createMockConfigIO(overrides: { deployedState?: any; projectSpec?: any }) {
  return {
    readDeployedState: vi.fn().mockResolvedValue(overrides.deployedState ?? defaultDeployedState),
    readProjectSpec: vi.fn().mockResolvedValue(overrides.projectSpec ?? defaultProjectSpecNone),
  } as any;
}

describe('fetchGatewayToken', () => {
  beforeEach(() => {
    global.fetch = vi.fn();
    vi.mocked(readEnvFile).mockResolvedValue({});
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('auth type NONE', () => {
    it('returns url and message with no token field', async () => {
      const configIO = createMockConfigIO({ projectSpec: defaultProjectSpecNone });

      const result = await fetchGatewayToken('myGateway', { configIO });

      expect(result).toEqual({
        url: GATEWAY_URL,
        authType: 'NONE',
        message: 'No authentication required. Send requests directly to the URL.',
      });
      expect(result).not.toHaveProperty('token');
    });
  });

  describe('auth type AWS_IAM', () => {
    it('returns url and message with no token field', async () => {
      const configIO = createMockConfigIO({ projectSpec: defaultProjectSpecAwsIam });

      const result = await fetchGatewayToken('myGateway', { configIO });

      expect(result).toEqual({
        url: GATEWAY_URL,
        authType: 'AWS_IAM',
        message: 'This gateway uses AWS IAM auth. Sign requests with SigV4 using your IAM credentials.',
      });
      expect(result).not.toHaveProperty('token');
    });
  });

  describe('auth type CUSTOM_JWT', () => {
    beforeEach(() => {
      vi.mocked(readEnvFile).mockResolvedValue({
        AGENTCORE_CREDENTIAL_MYGATEWAY_OAUTH_CLIENT_SECRET: 'test-secret',
        AGENTCORE_CREDENTIAL_MYGATEWAY_OAUTH_CLIENT_ID: 'test-client',
      });

      vi.mocked(global.fetch)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ token_endpoint: TOKEN_ENDPOINT }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ access_token: 'test-token', expires_in: 3600 }),
        } as Response);
    });

    it('performs OAuth flow and returns token with expiresIn', async () => {
      const configIO = createMockConfigIO({
        projectSpec: defaultProjectSpecCustomJwt,
      });

      const result = await fetchGatewayToken('myGateway', { configIO });

      expect(result).toEqual({
        url: GATEWAY_URL,
        authType: 'CUSTOM_JWT',
        token: 'test-token',
        expiresIn: 3600,
      });
    });

    it('uses tier 2 CLIENT_ID env var when set', async () => {
      vi.mocked(readEnvFile).mockResolvedValue({
        AGENTCORE_CREDENTIAL_MYGATEWAY_OAUTH_CLIENT_SECRET: 'test-secret',
        AGENTCORE_CREDENTIAL_MYGATEWAY_OAUTH_CLIENT_ID: 'tier2-client',
      });

      const configIO = createMockConfigIO({
        projectSpec: defaultProjectSpecCustomJwt,
      });

      await fetchGatewayToken('myGateway', { configIO });

      const tokenCall = vi.mocked(global.fetch).mock.calls[1]!;
      const body = tokenCall[1]?.body as string;
      expect(body).toContain('client_id=tier2-client');
    });

    it('falls back to tier 3 allowedClients[0] when no CLIENT_ID env var', async () => {
      vi.mocked(readEnvFile).mockResolvedValue({
        AGENTCORE_CREDENTIAL_MYGATEWAY_OAUTH_CLIENT_SECRET: 'test-secret',
      });

      const projectSpecWithFallbackClient = {
        ...baseProjectSpec,
        agentCoreGateways: [
          {
            name: 'myGateway',
            targets: [],
            authorizerType: 'CUSTOM_JWT',
            authorizerConfiguration: {
              customJwtAuthorizer: {
                discoveryUrl: DISCOVERY_URL,
                allowedClients: ['fallback-client'],
              },
            },
          },
        ],
      };

      const configIO = createMockConfigIO({
        projectSpec: projectSpecWithFallbackClient,
      });

      await fetchGatewayToken('myGateway', { configIO });

      const tokenCall = vi.mocked(global.fetch).mock.calls[1]!;
      const body = tokenCall[1]?.body as string;
      expect(body).toContain('client_id=fallback-client');
    });
  });

  describe('error cases', () => {
    it('throws when no deployed targets exist', async () => {
      const configIO = createMockConfigIO({
        deployedState: { targets: {} },
      });

      await expect(fetchGatewayToken('myGateway', { configIO })).rejects.toThrow(
        'No deployed targets found. Run `agentcore deploy` first.'
      );
    });

    it('throws with available names when gateway not found in project spec', async () => {
      const configIO = createMockConfigIO({
        projectSpec: {
          ...baseProjectSpec,
          agentCoreGateways: [{ name: 'otherGateway', targets: [], authorizerType: 'NONE' }],
        },
      });

      await expect(fetchGatewayToken('myGateway', { configIO })).rejects.toThrow(
        "Gateway 'myGateway' not found in MCP configuration. Available gateways: otherGateway"
      );
    });

    it('throws when gateway has no deployed URL', async () => {
      const deployedStateNoUrl = {
        targets: {
          default: {
            resources: {
              mcp: {
                gateways: {
                  myGateway: {
                    gatewayId: 'gw-123',
                    gatewayArn: 'arn:aws:bedrock:us-east-1:123456789012:gateway/gw-123',
                    // no gatewayUrl
                  },
                },
              },
            },
          },
        },
      };

      const configIO = createMockConfigIO({ deployedState: deployedStateNoUrl });

      await expect(fetchGatewayToken('myGateway', { configIO })).rejects.toThrow(
        "Gateway 'myGateway' does not have a deployed URL. Run `agentcore deploy` to deploy the gateway."
      );
    });

    it('throws when OAuthCredentialProvider is missing from project spec', async () => {
      const configIO = createMockConfigIO({
        projectSpec: {
          ...defaultProjectSpecCustomJwt,
          credentials: [],
        },
      });

      await expect(fetchGatewayToken('myGateway', { configIO })).rejects.toThrow(
        "Expected credential 'myGateway-oauth'"
      );
    });

    it('throws naming exact env var when client_secret is missing', async () => {
      vi.mocked(readEnvFile).mockResolvedValue({});

      const configIO = createMockConfigIO({
        projectSpec: defaultProjectSpecCustomJwt,
      });

      await expect(fetchGatewayToken('myGateway', { configIO })).rejects.toThrow(
        'AGENTCORE_CREDENTIAL_MYGATEWAY_OAUTH'
      );
    });

    it('throws when client_id is not resolvable', async () => {
      vi.mocked(readEnvFile).mockResolvedValue({
        AGENTCORE_CREDENTIAL_MYGATEWAY_OAUTH_CLIENT_SECRET: 'test-secret',
        // no CLIENT_ID env var
      });

      const projectSpecNoClients = {
        ...baseProjectSpec,
        agentCoreGateways: [
          {
            name: 'myGateway',
            targets: [],
            authorizerType: 'CUSTOM_JWT',
            authorizerConfiguration: {
              customJwtAuthorizer: {
                discoveryUrl: DISCOVERY_URL,
                // no allowedClients
              },
            },
          },
        ],
      };

      const configIO = createMockConfigIO({
        projectSpec: projectSpecNoClients,
      });

      await expect(fetchGatewayToken('myGateway', { configIO })).rejects.toThrow('Could not determine OAuth client ID');
    });

    it('throws when OIDC discovery returns non-ok response', async () => {
      vi.mocked(readEnvFile).mockResolvedValue({
        AGENTCORE_CREDENTIAL_MYGATEWAY_OAUTH_CLIENT_SECRET: 'test-secret',
        AGENTCORE_CREDENTIAL_MYGATEWAY_OAUTH_CLIENT_ID: 'test-client',
      });

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      } as Response);

      const configIO = createMockConfigIO({
        projectSpec: defaultProjectSpecCustomJwt,
      });

      await expect(fetchGatewayToken('myGateway', { configIO })).rejects.toThrow('OIDC discovery failed: 404');
    });

    it('throws with status and error body when token request fails', async () => {
      vi.mocked(readEnvFile).mockResolvedValue({
        AGENTCORE_CREDENTIAL_MYGATEWAY_OAUTH_CLIENT_SECRET: 'test-secret',
        AGENTCORE_CREDENTIAL_MYGATEWAY_OAUTH_CLIENT_ID: 'test-client',
      });

      vi.mocked(global.fetch)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ token_endpoint: TOKEN_ENDPOINT }),
        } as Response)
        .mockResolvedValueOnce({
          ok: false,
          status: 401,
          statusText: 'Unauthorized',
          text: () => Promise.resolve('{"error":"invalid_client"}'),
        } as Response);

      const configIO = createMockConfigIO({
        projectSpec: defaultProjectSpecCustomJwt,
      });

      await expect(fetchGatewayToken('myGateway', { configIO })).rejects.toThrow('Token request failed: 401');
    });
  });
});
