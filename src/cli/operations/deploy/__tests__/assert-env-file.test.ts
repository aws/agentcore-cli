import type { AgentCoreProjectSpec } from '../../../../schema';
import { assertEnvFileExists, getAllCredentials } from '../pre-deploy-identity';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockExistsSync } = vi.hoisted(() => ({ mockExistsSync: vi.fn() }));
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual, existsSync: mockExistsSync };
});

const BASE_DIR = '/fake/project/agentcore';

function makeSpec(overrides: Partial<AgentCoreProjectSpec> = {}): AgentCoreProjectSpec {
  return {
    name: 'TestProject',
    version: 1,
    managedBy: 'CDK',
    runtimes: [],
    memories: [],
    credentials: [],
    evaluators: [],
    onlineEvalConfigs: [],
    agentCoreGateways: [],
    policyEngines: [],
    payments: [],
    ...overrides,
  } as AgentCoreProjectSpec;
}

describe('assertEnvFileExists', () => {
  beforeEach(() => {
    mockExistsSync.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when no credentials exist (file missing is fine)', () => {
    mockExistsSync.mockReturnValue(false);
    const result = assertEnvFileExists(makeSpec(), BASE_DIR);
    expect(result).toBeNull();
  });

  it('returns null when file exists', () => {
    mockExistsSync.mockReturnValue(true);
    const spec = makeSpec({
      credentials: [{ name: 'mykey', authorizerType: 'ApiKeyCredentialProvider' } as any],
    });
    const result = assertEnvFileExists(spec, BASE_DIR);
    expect(result).toBeNull();
  });

  it('lists ApiKey env vars when file is missing', () => {
    mockExistsSync.mockReturnValue(false);
    const spec = makeSpec({
      credentials: [{ name: 'openai', authorizerType: 'ApiKeyCredentialProvider' } as any],
    });
    const result = assertEnvFileExists(spec, BASE_DIR);
    expect(result).toContain('agentcore/.env.local not found');
    expect(result).toContain('AGENTCORE_CREDENTIAL_OPENAI');
  });

  it('lists OAuth2 env vars when file is missing', () => {
    mockExistsSync.mockReturnValue(false);
    const spec = makeSpec({
      credentials: [{ name: 'google-oauth', authorizerType: 'OAuthCredentialProvider' } as any],
    });
    const result = assertEnvFileExists(spec, BASE_DIR);
    expect(result).toContain('AGENTCORE_CREDENTIAL_GOOGLE_OAUTH_CLIENT_ID');
    expect(result).toContain('AGENTCORE_CREDENTIAL_GOOGLE_OAUTH_CLIENT_SECRET');
  });

  it('lists CoinbaseCDP payment env vars when file is missing', () => {
    mockExistsSync.mockReturnValue(false);
    const spec = makeSpec({
      payments: [
        {
          name: 'PayMgr',
          authorizerType: 'AWS_IAM',
          connectors: [{ name: 'cdpconn', provider: 'CoinbaseCDP', credentialName: 'PayMgr-cdpconn-cdp' }],
        } as any,
      ],
    });
    const result = assertEnvFileExists(spec, BASE_DIR);
    expect(result).toContain('AGENTCORE_CREDENTIAL_PAYMGR_CDPCONN_CDP_API_KEY_ID');
    expect(result).toContain('AGENTCORE_CREDENTIAL_PAYMGR_CDPCONN_CDP_API_KEY_SECRET');
    expect(result).toContain('AGENTCORE_CREDENTIAL_PAYMGR_CDPCONN_CDP_WALLET_SECRET');
  });

  it('lists StripePrivy payment env vars when file is missing', () => {
    mockExistsSync.mockReturnValue(false);
    const spec = makeSpec({
      payments: [
        {
          name: 'PayMgr',
          authorizerType: 'AWS_IAM',
          connectors: [
            { name: 'stripeconn', provider: 'StripePrivy', credentialName: 'PayMgr-stripeconn-stripe-privy' },
          ],
        } as any,
      ],
    });
    const result = assertEnvFileExists(spec, BASE_DIR);
    expect(result).toContain('APP_ID');
    expect(result).toContain('APP_SECRET');
    expect(result).toContain('AUTHORIZATION_PRIVATE_KEY');
    expect(result).toContain('AUTHORIZATION_ID');
  });

  it('combines all credential types in a single error', () => {
    mockExistsSync.mockReturnValue(false);
    const spec = makeSpec({
      credentials: [
        { name: 'openai', authorizerType: 'ApiKeyCredentialProvider' } as any,
        { name: 'google', authorizerType: 'OAuthCredentialProvider' } as any,
      ],
      payments: [
        {
          name: 'PayMgr',
          authorizerType: 'AWS_IAM',
          connectors: [{ name: 'cdpconn', provider: 'CoinbaseCDP', credentialName: 'PayMgr-cdpconn-cdp' }],
        } as any,
      ],
    });
    const result = assertEnvFileExists(spec, BASE_DIR);
    expect(result).toContain('AGENTCORE_CREDENTIAL_OPENAI');
    expect(result).toContain('AGENTCORE_CREDENTIAL_GOOGLE_CLIENT_ID');
    expect(result).toContain('AGENTCORE_CREDENTIAL_PAYMGR_CDPCONN_CDP_API_KEY_ID');
  });
});

describe('getAllCredentials', () => {
  it('returns empty when no credentials configured', () => {
    expect(getAllCredentials(makeSpec())).toEqual([]);
  });

  it('includes payment connector env vars', () => {
    const spec = makeSpec({
      payments: [
        {
          name: 'PayMgr',
          authorizerType: 'AWS_IAM',
          connectors: [{ name: 'cdpconn', provider: 'CoinbaseCDP', credentialName: 'PayMgr-cdpconn-cdp' }],
        } as any,
      ],
    });
    const result = getAllCredentials(spec);
    expect(result.length).toBe(3);
    expect(result.every(c => c.providerName === 'PayMgr-cdpconn-cdp')).toBe(true);
  });
});
