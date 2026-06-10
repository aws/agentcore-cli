import { cleanupPaymentCredentialProviders, setupPaymentCredentialProviders } from '../pre-deploy-identity.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

// ============================================================================
// Hoisted mocks
// ============================================================================

const {
  mockCreatePaymentCredentialProvider,
  mockUpdatePaymentCredentialProvider,
  mockGetPaymentCredentialProvider,
  mockDeletePaymentCredentialProvider,
  mockReadEnvFile,
  mockExistsSync,
} = vi.hoisted(() => ({
  mockCreatePaymentCredentialProvider: vi.fn(),
  mockUpdatePaymentCredentialProvider: vi.fn(),
  mockGetPaymentCredentialProvider: vi.fn(),
  mockDeletePaymentCredentialProvider: vi.fn(),
  mockReadEnvFile: vi.fn(),
  mockExistsSync: vi.fn(),
}));

vi.mock('../../../aws/agentcore-payments', () => ({
  createPaymentCredentialProvider: mockCreatePaymentCredentialProvider,
  updatePaymentCredentialProvider: mockUpdatePaymentCredentialProvider,
  getPaymentCredentialProvider: mockGetPaymentCredentialProvider,
  deletePaymentCredentialProvider: mockDeletePaymentCredentialProvider,
}));

vi.mock('../../../../lib', () => ({
  SecureCredentials: class {
    constructor(private envVars: Record<string, string>) {}
    static fromEnvVars(envVars: Record<string, string>) {
      return new this(envVars);
    }
    merge(_other: unknown) {
      return this;
    }
    get(key: string) {
      return this.envVars[key];
    }
  },
  readEnvFile: mockReadEnvFile,
}));

vi.mock('fs', () => ({
  existsSync: mockExistsSync,
}));

vi.mock('../../../errors', () => ({
  isNoCredentialsError: () => false,
  isQuotaExceededError: () => false,
}));

vi.mock('../../../external-requirements/checks', () => ({
  getAwsLoginGuidance: vi.fn().mockResolvedValue('Run: aws sso login'),
}));

// ============================================================================
// Shared fixtures
// ============================================================================

const BASE_DIR = '/project/agentcore';
const REGION = 'us-east-1';

function makeCoinbaseSpec(credentialName = 'my-cdp-cred') {
  return {
    name: 'test-project',
    payments: [
      {
        name: 'my-payment-manager',
        connectors: [
          {
            name: 'my-connector',
            provider: 'CoinbaseCDP' as const,
            credentialName,
          },
        ],
      },
    ],
    credentials: [
      {
        name: credentialName,
        authorizerType: 'PaymentCredentialProvider' as const,
      },
    ],
    runtimes: [],
  };
}

function makeStripePrivySpec(credentialName = 'my-stripe-cred') {
  return {
    name: 'test-project',
    payments: [
      {
        name: 'my-payment-manager',
        connectors: [
          {
            name: 'my-connector',
            provider: 'StripePrivy' as const,
            credentialName,
          },
        ],
      },
    ],
    credentials: [
      {
        name: credentialName,
        authorizerType: 'PaymentCredentialProvider' as const,
      },
    ],
    runtimes: [],
  };
}

// ============================================================================
// setupPaymentCredentialProviders
// ============================================================================

describe('setupPaymentCredentialProviders', () => {
  afterEach(() => vi.clearAllMocks());

  it('returns empty credentialProviders when payments array is empty', async () => {
    const projectSpec = {
      name: 'test-project',
      payments: [],
      credentials: [],
      runtimes: [],
    };

    const result = await setupPaymentCredentialProviders({
      projectSpec: projectSpec as any,
      configBaseDir: BASE_DIR,
      region: REGION,
    });

    expect(result.hasErrors).toBe(false);
    expect(result.errors).toHaveLength(0);
    expect(result.credentialProviders).toEqual({});
    expect(mockGetPaymentCredentialProvider).not.toHaveBeenCalled();
    expect(mockCreatePaymentCredentialProvider).not.toHaveBeenCalled();
  });

  it('creates a new credential provider when none exists', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadEnvFile.mockResolvedValue({
      AGENTCORE_CREDENTIAL_MY_CDP_CRED_API_KEY_ID: 'key-id-123',
      AGENTCORE_CREDENTIAL_MY_CDP_CRED_API_KEY_SECRET: 'key-secret-abc',
      AGENTCORE_CREDENTIAL_MY_CDP_CRED_WALLET_SECRET: 'wallet-secret-xyz',
    });
    mockGetPaymentCredentialProvider.mockResolvedValue(null);
    mockCreatePaymentCredentialProvider.mockResolvedValue({
      credentialProviderArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789:payment-credential-provider/my-cdp-cred',
      status: 'ACTIVE',
    });

    const result = await setupPaymentCredentialProviders({
      projectSpec: makeCoinbaseSpec() as any,
      configBaseDir: BASE_DIR,
      region: REGION,
    });

    expect(result.hasErrors).toBe(false);
    expect(result.errors).toHaveLength(0);
    expect(mockCreatePaymentCredentialProvider).toHaveBeenCalledOnce();
    expect(mockUpdatePaymentCredentialProvider).not.toHaveBeenCalled();
    expect(result.credentialProviders['my-cdp-cred']).toEqual({
      credentialProviderArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789:payment-credential-provider/my-cdp-cred',
      credentialProviderName: 'my-cdp-cred',
    });
  });

  it('updates an existing credential provider when one already exists', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadEnvFile.mockResolvedValue({
      AGENTCORE_CREDENTIAL_MY_CDP_CRED_API_KEY_ID: 'key-id-123',
      AGENTCORE_CREDENTIAL_MY_CDP_CRED_API_KEY_SECRET: 'key-secret-abc',
      AGENTCORE_CREDENTIAL_MY_CDP_CRED_WALLET_SECRET: 'wallet-secret-xyz',
    });
    mockGetPaymentCredentialProvider.mockResolvedValue({
      credentialProviderArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789:payment-credential-provider/my-cdp-cred',
      name: 'my-cdp-cred',
      status: 'ACTIVE',
    });
    mockUpdatePaymentCredentialProvider.mockResolvedValue({
      credentialProviderArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789:payment-credential-provider/my-cdp-cred',
      status: 'ACTIVE',
    });

    const result = await setupPaymentCredentialProviders({
      projectSpec: makeCoinbaseSpec() as any,
      configBaseDir: BASE_DIR,
      region: REGION,
    });

    expect(result.hasErrors).toBe(false);
    expect(mockUpdatePaymentCredentialProvider).toHaveBeenCalledOnce();
    expect(mockCreatePaymentCredentialProvider).not.toHaveBeenCalled();
    expect(result.credentialProviders['my-cdp-cred']?.credentialProviderArn).toBe(
      'arn:aws:bedrock-agentcore:us-east-1:123456789:payment-credential-provider/my-cdp-cred'
    );
  });

  it('returns error when specific CoinbaseCDP env vars are missing from .env.local', async () => {
    mockExistsSync.mockReturnValue(true);
    // Only provide apiKeyId — leave secret and walletSecret absent
    mockReadEnvFile.mockResolvedValue({
      AGENTCORE_CREDENTIAL_MY_CDP_CRED_API_KEY_ID: 'key-id-123',
    });
    mockGetPaymentCredentialProvider.mockResolvedValue(null);

    const result = await setupPaymentCredentialProviders({
      projectSpec: makeCoinbaseSpec() as any,
      configBaseDir: BASE_DIR,
      region: REGION,
    });

    expect(result.hasErrors).toBe(true);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Missing CDP credentials');
    expect(result.errors[0]).toContain('AGENTCORE_CREDENTIAL_MY_CDP_CRED_API_KEY_SECRET');
    expect(result.errors[0]).toContain('AGENTCORE_CREDENTIAL_MY_CDP_CRED_WALLET_SECRET');
    expect(mockCreatePaymentCredentialProvider).not.toHaveBeenCalled();
  });

  it('returns error when specific StripePrivy env vars are missing from .env.local', async () => {
    mockExistsSync.mockReturnValue(true);
    // Provide only appId — leave others absent
    mockReadEnvFile.mockResolvedValue({
      AGENTCORE_CREDENTIAL_MY_STRIPE_CRED_APP_ID: 'app-id-123',
    });
    mockGetPaymentCredentialProvider.mockResolvedValue(null);

    const result = await setupPaymentCredentialProviders({
      projectSpec: makeStripePrivySpec() as any,
      configBaseDir: BASE_DIR,
      region: REGION,
    });

    expect(result.hasErrors).toBe(true);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Missing StripePrivy credentials');
    expect(result.errors[0]).toContain('AGENTCORE_CREDENTIAL_MY_STRIPE_CRED_APP_SECRET');
    expect(result.errors[0]).toContain('AGENTCORE_CREDENTIAL_MY_STRIPE_CRED_AUTHORIZATION_PRIVATE_KEY');
    expect(result.errors[0]).toContain('AGENTCORE_CREDENTIAL_MY_STRIPE_CRED_AUTHORIZATION_ID');
    expect(mockCreatePaymentCredentialProvider).not.toHaveBeenCalled();
  });

  it('resolves all 3 CoinbaseCDP env vars and passes them to create', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadEnvFile.mockResolvedValue({
      AGENTCORE_CREDENTIAL_MY_CDP_CRED_API_KEY_ID: 'key-id-123',
      AGENTCORE_CREDENTIAL_MY_CDP_CRED_API_KEY_SECRET: 'key-secret-abc',
      AGENTCORE_CREDENTIAL_MY_CDP_CRED_WALLET_SECRET: 'wallet-secret-xyz',
    });
    mockGetPaymentCredentialProvider.mockResolvedValue(null);
    mockCreatePaymentCredentialProvider.mockResolvedValue({
      credentialProviderArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789:payment-credential-provider/my-cdp-cred',
      status: 'ACTIVE',
    });

    await setupPaymentCredentialProviders({
      projectSpec: makeCoinbaseSpec() as any,
      configBaseDir: BASE_DIR,
      region: REGION,
    });

    expect(mockCreatePaymentCredentialProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        vendor: 'CoinbaseCDP',
        name: 'my-cdp-cred',
        apiKeyId: 'key-id-123',
        apiKeySecret: 'key-secret-abc',
        walletSecret: 'wallet-secret-xyz',
        region: REGION,
      })
    );
  });

  it('resolves all 4 StripePrivy env vars and passes them to create', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadEnvFile.mockResolvedValue({
      AGENTCORE_CREDENTIAL_MY_STRIPE_CRED_APP_ID: 'app-id-123',
      AGENTCORE_CREDENTIAL_MY_STRIPE_CRED_APP_SECRET: 'app-secret-abc',
      AGENTCORE_CREDENTIAL_MY_STRIPE_CRED_AUTHORIZATION_PRIVATE_KEY: 'priv-key-xyz',
      AGENTCORE_CREDENTIAL_MY_STRIPE_CRED_AUTHORIZATION_ID: 'auth-id-456',
    });
    mockGetPaymentCredentialProvider.mockResolvedValue(null);
    mockCreatePaymentCredentialProvider.mockResolvedValue({
      credentialProviderArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789:payment-credential-provider/my-stripe-cred',
      status: 'ACTIVE',
    });

    await setupPaymentCredentialProviders({
      projectSpec: makeStripePrivySpec() as any,
      configBaseDir: BASE_DIR,
      region: REGION,
    });

    expect(mockCreatePaymentCredentialProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        vendor: 'StripePrivy',
        name: 'my-stripe-cred',
        appId: 'app-id-123',
        appSecret: 'app-secret-abc',
        authorizationPrivateKey: 'priv-key-xyz',
        authorizationId: 'auth-id-456',
        region: REGION,
      })
    );
  });
});

// ============================================================================
// cleanupPaymentCredentialProviders
// ============================================================================

describe('cleanupPaymentCredentialProviders', () => {
  afterEach(() => vi.clearAllMocks());

  it('deletes credential providers by name extracted from ARN', async () => {
    mockDeletePaymentCredentialProvider.mockResolvedValue(undefined);

    await cleanupPaymentCredentialProviders({
      region: REGION,
      payments: {
        'my-payment-manager': {
          connectors: {
            'my-connector': {
              credentialProviderArn:
                'arn:aws:bedrock-agentcore:us-east-1:123456789:payment-credential-provider/my-cdp-cred',
            },
          },
        },
      },
    });

    expect(mockDeletePaymentCredentialProvider).toHaveBeenCalledOnce();
    expect(mockDeletePaymentCredentialProvider).toHaveBeenCalledWith({
      region: REGION,
      name: 'my-cdp-cred',
    });
  });

  it('deletes multiple credential providers across managers and connectors', async () => {
    mockDeletePaymentCredentialProvider.mockResolvedValue(undefined);

    await cleanupPaymentCredentialProviders({
      region: REGION,
      payments: {
        'manager-a': {
          connectors: {
            'connector-1': {
              credentialProviderArn:
                'arn:aws:bedrock-agentcore:us-east-1:123456789:payment-credential-provider/cred-one',
            },
            'connector-2': {
              credentialProviderArn:
                'arn:aws:bedrock-agentcore:us-east-1:123456789:payment-credential-provider/cred-two',
            },
          },
        },
        'manager-b': {
          connectors: {
            'connector-3': {
              credentialProviderArn:
                'arn:aws:bedrock-agentcore:us-east-1:123456789:payment-credential-provider/cred-three',
            },
          },
        },
      },
    });

    expect(mockDeletePaymentCredentialProvider).toHaveBeenCalledTimes(3);
    expect(mockDeletePaymentCredentialProvider).toHaveBeenCalledWith({ region: REGION, name: 'cred-one' });
    expect(mockDeletePaymentCredentialProvider).toHaveBeenCalledWith({ region: REGION, name: 'cred-two' });
    expect(mockDeletePaymentCredentialProvider).toHaveBeenCalledWith({ region: REGION, name: 'cred-three' });
  });

  it('ignores 404 errors gracefully without throwing', async () => {
    mockDeletePaymentCredentialProvider.mockRejectedValue(new Error('Payment API error (404): resource not found'));

    await expect(
      cleanupPaymentCredentialProviders({
        region: REGION,
        payments: {
          'my-payment-manager': {
            connectors: {
              'my-connector': {
                credentialProviderArn:
                  'arn:aws:bedrock-agentcore:us-east-1:123456789:payment-credential-provider/my-cdp-cred',
              },
            },
          },
        },
      })
    ).resolves.toBeUndefined();
  });

  it('ignores NotFound errors gracefully without throwing', async () => {
    mockDeletePaymentCredentialProvider.mockRejectedValue(new Error('ResourceNotFoundException: not found'));

    await expect(
      cleanupPaymentCredentialProviders({
        region: REGION,
        payments: {
          'my-payment-manager': {
            connectors: {
              'my-connector': {
                credentialProviderArn:
                  'arn:aws:bedrock-agentcore:us-east-1:123456789:payment-credential-provider/my-cdp-cred',
              },
            },
          },
        },
      })
    ).resolves.toBeUndefined();
  });

  it('makes no API calls when payments object is empty', async () => {
    await cleanupPaymentCredentialProviders({
      region: REGION,
      payments: {},
    });

    expect(mockDeletePaymentCredentialProvider).not.toHaveBeenCalled();
  });

  it('makes no API calls when a manager has no connectors', async () => {
    await cleanupPaymentCredentialProviders({
      region: REGION,
      payments: {
        'my-payment-manager': {},
      },
    });

    expect(mockDeletePaymentCredentialProvider).not.toHaveBeenCalled();
  });
});
