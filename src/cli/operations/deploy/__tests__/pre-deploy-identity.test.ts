import {
  getAllCredentials,
  hasIdentityOAuthProviders,
  reconcileCredentialProviders,
  setupApiKeyProviders,
  setupOAuth2Providers,
} from '../pre-deploy-identity.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockKmsSend,
  mockControlSend,
  mockSetTokenVaultKmsKey,
  mockReadEnvFile,
  mockGetCredentialProvider,
  mockOAuth2ProviderExists,
  mockCreateOAuth2Provider,
  mockUpdateOAuth2Provider,
  mockDeleteOAuth2Provider,
  mockDeleteApiKeyProvider,
} = vi.hoisted(() => ({
  mockKmsSend: vi.fn(),
  mockControlSend: vi.fn(),
  mockSetTokenVaultKmsKey: vi.fn(),
  mockReadEnvFile: vi.fn(),
  mockGetCredentialProvider: vi.fn(),
  mockOAuth2ProviderExists: vi.fn(),
  mockCreateOAuth2Provider: vi.fn(),
  mockUpdateOAuth2Provider: vi.fn(),
  mockDeleteOAuth2Provider: vi.fn(),
  mockDeleteApiKeyProvider: vi.fn(),
}));

vi.mock('@aws-sdk/client-kms', () => ({
  KMSClient: class {
    send = mockKmsSend;
  },
  CreateKeyCommand: class {
    constructor(public input: unknown) {}
  },
}));

vi.mock('@aws-sdk/client-bedrock-agentcore-control', () => ({
  BedrockAgentCoreControlClient: class {
    send = mockControlSend;
  },
  GetTokenVaultCommand: class {
    constructor(public input: unknown) {}
  },
}));

vi.mock('../../identity/index.js', () => ({
  apiKeyProviderExists: vi.fn(),
  createApiKeyProvider: vi.fn(),
  deleteApiKeyProvider: mockDeleteApiKeyProvider,
  setTokenVaultKmsKey: mockSetTokenVaultKmsKey,
  updateApiKeyProvider: vi.fn(),
  oAuth2ProviderExists: mockOAuth2ProviderExists,
  createOAuth2Provider: mockCreateOAuth2Provider,
  deleteOAuth2Provider: mockDeleteOAuth2Provider,
  updateOAuth2Provider: mockUpdateOAuth2Provider,
}));

vi.mock('../../../primitives/credential-utils.js', () => ({
  computeDefaultCredentialEnvVarName: vi.fn(
    (name: string) => `AGENTCORE_CREDENTIAL_${name.replace(/-/g, '_').toUpperCase()}`
  ),
}));

vi.mock('../../../../lib/index.js', () => ({
  SecureCredentials: class {
    constructor(private envVars: Record<string, string>) {}
    static fromEnvVars(envVars: Record<string, string>) {
      return new this(envVars);
    }
    merge(_other: any) {
      return this;
    }
    get(key: string) {
      return this.envVars[key];
    }
  },
  readEnvFile: mockReadEnvFile,
  MissingCredentialsError: class MissingCredentialsError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'MissingCredentialsError';
    }
  },
  toError: (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
}));

vi.mock('../../../aws/index.js', () => ({
  getCredentialProvider: mockGetCredentialProvider,
}));

vi.mock('../../../errors.js', () => ({
  isNoCredentialsError: () => false,
}));

const mockProjectSpec = {
  name: 'test-project',
  credentials: [],
  runtimes: [],
};

describe('setupApiKeyProviders - KMS key reuse via GetTokenVault', () => {
  afterEach(() => vi.clearAllMocks());

  beforeEach(() => {
    mockReadEnvFile.mockResolvedValue({});
    mockGetCredentialProvider.mockReturnValue({});
  });

  it('reuses existing CMK from token vault', async () => {
    mockControlSend.mockResolvedValue({
      tokenVaultId: 'default',
      kmsConfiguration: {
        keyType: 'CustomerManagedKey',
        kmsKeyArn: 'arn:aws:kms:us-east-1:123:key/existing',
      },
    });

    const result = await setupApiKeyProviders({
      projectSpec: mockProjectSpec as any,
      configBaseDir: '/tmp',
      region: 'us-east-1',
      enableKmsEncryption: true,
    });

    expect(result.kmsKeyArn).toBe('arn:aws:kms:us-east-1:123:key/existing');
    expect(result.hasErrors).toBe(false);
    // Should not create a new KMS key
    expect(mockKmsSend).not.toHaveBeenCalled();
    expect(mockSetTokenVaultKmsKey).not.toHaveBeenCalled();
  });

  it('creates new key when vault uses ServiceManagedKey', async () => {
    mockControlSend.mockResolvedValue({
      tokenVaultId: 'default',
      kmsConfiguration: { keyType: 'ServiceManagedKey' },
    });
    mockKmsSend.mockResolvedValue({
      KeyMetadata: { Arn: 'arn:aws:kms:us-east-1:123:key/new-key' },
    });
    mockSetTokenVaultKmsKey.mockResolvedValue({ success: true });

    const result = await setupApiKeyProviders({
      projectSpec: mockProjectSpec as any,
      configBaseDir: '/tmp',
      region: 'us-east-1',
      enableKmsEncryption: true,
    });

    expect(result.kmsKeyArn).toBe('arn:aws:kms:us-east-1:123:key/new-key');
    expect(result.hasErrors).toBe(false);
    expect(mockKmsSend).toHaveBeenCalledTimes(1);
    expect(mockSetTokenVaultKmsKey).toHaveBeenCalledWith(expect.anything(), 'arn:aws:kms:us-east-1:123:key/new-key');
  });

  it('creates new key when GetTokenVault throws', async () => {
    mockControlSend.mockRejectedValue(new Error('ResourceNotFoundException'));
    mockKmsSend.mockResolvedValue({
      KeyMetadata: { Arn: 'arn:aws:kms:us-east-1:123:key/new-key' },
    });
    mockSetTokenVaultKmsKey.mockResolvedValue({ success: true });

    const result = await setupApiKeyProviders({
      projectSpec: mockProjectSpec as any,
      configBaseDir: '/tmp',
      region: 'us-east-1',
      enableKmsEncryption: true,
    });

    expect(result.kmsKeyArn).toBe('arn:aws:kms:us-east-1:123:key/new-key');
    expect(result.hasErrors).toBe(false);
    expect(mockKmsSend).toHaveBeenCalledTimes(1);
  });

  it('creates new key when vault CMK has no ARN', async () => {
    mockControlSend.mockResolvedValue({
      tokenVaultId: 'default',
      kmsConfiguration: { keyType: 'CustomerManagedKey' },
    });
    mockKmsSend.mockResolvedValue({
      KeyMetadata: { Arn: 'arn:aws:kms:us-east-1:123:key/new-key' },
    });
    mockSetTokenVaultKmsKey.mockResolvedValue({ success: true });

    const result = await setupApiKeyProviders({
      projectSpec: mockProjectSpec as any,
      configBaseDir: '/tmp',
      region: 'us-east-1',
      enableKmsEncryption: true,
    });

    expect(result.kmsKeyArn).toBe('arn:aws:kms:us-east-1:123:key/new-key');
    expect(mockKmsSend).toHaveBeenCalledTimes(1);
  });

  it('does not set up KMS when enableKmsEncryption is false', async () => {
    const result = await setupApiKeyProviders({
      projectSpec: mockProjectSpec as any,
      configBaseDir: '/tmp',
      region: 'us-east-1',
      enableKmsEncryption: false,
    });

    expect(result.kmsKeyArn).toBeUndefined();
    expect(result.hasErrors).toBe(false);
    expect(mockControlSend).not.toHaveBeenCalled();
    expect(mockKmsSend).not.toHaveBeenCalled();
  });
});

describe('hasIdentityOAuthProviders', () => {
  it('returns true when OAuthCredentialProvider exists', () => {
    const projectSpec = {
      credentials: [
        { name: 'oauth-cred', authorizerType: 'OAuthCredentialProvider' },
        { name: 'api-cred', authorizerType: 'ApiKeyCredentialProvider' },
      ],
    };
    expect(hasIdentityOAuthProviders(projectSpec as any)).toBe(true);
  });

  it('returns false when only ApiKey credentials exist', () => {
    const projectSpec = {
      credentials: [{ name: 'api-cred', authorizerType: 'ApiKeyCredentialProvider' }],
    };
    expect(hasIdentityOAuthProviders(projectSpec as any)).toBe(false);
  });

  it('returns false when no credentials exist', () => {
    const projectSpec = { credentials: [] };
    expect(hasIdentityOAuthProviders(projectSpec as any)).toBe(false);
  });
});

describe('getAllCredentials', () => {
  it('returns API key env var for ApiKeyCredentialProvider', () => {
    const projectSpec = {
      credentials: [{ name: 'test-api', authorizerType: 'ApiKeyCredentialProvider' }],
    };
    const result = getAllCredentials(projectSpec as any);
    expect(result).toEqual([{ providerName: 'test-api', envVarName: 'AGENTCORE_CREDENTIAL_TEST_API' }]);
  });

  it('returns CLIENT_ID and CLIENT_SECRET vars for OAuthCredentialProvider', () => {
    const projectSpec = {
      credentials: [{ name: 'oauth-provider', authorizerType: 'OAuthCredentialProvider' }],
    };
    const result = getAllCredentials(projectSpec as any);
    expect(result).toEqual([
      { providerName: 'oauth-provider', envVarName: 'AGENTCORE_CREDENTIAL_OAUTH_PROVIDER_CLIENT_ID' },
      { providerName: 'oauth-provider', envVarName: 'AGENTCORE_CREDENTIAL_OAUTH_PROVIDER_CLIENT_SECRET' },
    ]);
  });

  it('handles both credential types together', () => {
    const projectSpec = {
      credentials: [
        { name: 'api-key', authorizerType: 'ApiKeyCredentialProvider' },
        { name: 'oauth-cred', authorizerType: 'OAuthCredentialProvider' },
      ],
    };
    const result = getAllCredentials(projectSpec as any);
    expect(result).toEqual([
      { providerName: 'api-key', envVarName: 'AGENTCORE_CREDENTIAL_API_KEY' },
      { providerName: 'oauth-cred', envVarName: 'AGENTCORE_CREDENTIAL_OAUTH_CRED_CLIENT_ID' },
      { providerName: 'oauth-cred', envVarName: 'AGENTCORE_CREDENTIAL_OAUTH_CRED_CLIENT_SECRET' },
    ]);
  });

  it('uppercases and replaces hyphens with underscores', () => {
    const projectSpec = {
      credentials: [{ name: 'my-oauth-provider', authorizerType: 'OAuthCredentialProvider' }],
    };
    const result = getAllCredentials(projectSpec as any);
    expect(result[0]!.envVarName).toBe('AGENTCORE_CREDENTIAL_MY_OAUTH_PROVIDER_CLIENT_ID');
    expect(result[1]!.envVarName).toBe('AGENTCORE_CREDENTIAL_MY_OAUTH_PROVIDER_CLIENT_SECRET');
  });
});

describe('setupOAuth2Providers', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('creates OAuth2 provider when it does not exist', async () => {
    mockReadEnvFile.mockResolvedValue({
      AGENTCORE_CREDENTIAL_TEST_OAUTH_CLIENT_ID: 'client123',
      AGENTCORE_CREDENTIAL_TEST_OAUTH_CLIENT_SECRET: 'secret456',
    });
    mockOAuth2ProviderExists.mockResolvedValue(false);
    mockCreateOAuth2Provider.mockResolvedValue({
      success: true,
      result: { credentialProviderArn: 'arn:provider', clientSecretArn: 'arn:secret', callbackUrl: 'https://callback' },
    });

    const projectSpec = {
      credentials: [
        {
          name: 'test-oauth',
          authorizerType: 'OAuthCredentialProvider',
          vendor: 'Google',
          discoveryUrl: 'https://accounts.google.com/.well-known/openid_configuration',
        },
      ],
    };

    const result = await setupOAuth2Providers({
      projectSpec: projectSpec as any,
      configBaseDir: '/tmp',
      region: 'us-east-1',
    });

    expect(result.hasErrors).toBe(false);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.status).toBe('created');
    expect(mockCreateOAuth2Provider).toHaveBeenCalledWith(expect.anything(), {
      name: 'test-oauth',
      vendor: 'Google',
      discoveryUrl: 'https://accounts.google.com/.well-known/openid_configuration',
      clientId: 'client123',
      clientSecret: 'secret456',
    });
  });

  it('updates OAuth2 provider when it exists', async () => {
    mockReadEnvFile.mockResolvedValue({
      AGENTCORE_CREDENTIAL_TEST_OAUTH_CLIENT_ID: 'client123',
      AGENTCORE_CREDENTIAL_TEST_OAUTH_CLIENT_SECRET: 'secret456',
    });
    mockOAuth2ProviderExists.mockResolvedValue(true);
    mockUpdateOAuth2Provider.mockResolvedValue({ success: true, result: {} });

    const projectSpec = {
      credentials: [
        {
          name: 'test-oauth',
          authorizerType: 'OAuthCredentialProvider',
          discoveryUrl: 'https://accounts.google.com/.well-known/openid_configuration',
        },
      ],
    };

    const result = await setupOAuth2Providers({
      projectSpec: projectSpec as any,
      configBaseDir: '/tmp',
      region: 'us-east-1',
    });

    expect(result.hasErrors).toBe(false);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.status).toBe('updated');
    expect(mockUpdateOAuth2Provider).toHaveBeenCalled();
  });

  it('skips when env vars are missing', async () => {
    mockReadEnvFile.mockResolvedValue({});

    const projectSpec = {
      credentials: [{ name: 'test-oauth', authorizerType: 'OAuthCredentialProvider' }],
    };

    const result = await setupOAuth2Providers({
      projectSpec: projectSpec as any,
      configBaseDir: '/tmp',
      region: 'us-east-1',
    });

    expect(result.hasErrors).toBe(false);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.status).toBe('skipped');
    expect(result.results[0]!.error?.message).toContain('Missing');
  });

  it('returns error on failure', async () => {
    mockReadEnvFile.mockResolvedValue({
      AGENTCORE_CREDENTIAL_TEST_OAUTH_CLIENT_ID: 'client123',
      AGENTCORE_CREDENTIAL_TEST_OAUTH_CLIENT_SECRET: 'secret456',
    });
    mockOAuth2ProviderExists.mockResolvedValue(false);
    mockCreateOAuth2Provider.mockResolvedValue({ success: false, error: 'Creation failed' });

    const projectSpec = {
      credentials: [
        {
          name: 'test-oauth',
          authorizerType: 'OAuthCredentialProvider',
          discoveryUrl: 'https://accounts.google.com/.well-known/openid_configuration',
        },
      ],
    };

    const result = await setupOAuth2Providers({
      projectSpec: projectSpec as any,
      configBaseDir: '/tmp',
      region: 'us-east-1',
    });

    expect(result.hasErrors).toBe(true);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.status).toBe('error');
    expect(result.results[0]!.error).toBe('Creation failed');
  });
});

describe('reconcileCredentialProviders', () => {
  const ARN_BASE = 'arn:aws:bedrock-agentcore:us-east-1:123456789012:token-vault/default';
  const oauth2Arn = (name: string) => `${ARN_BASE}/oauth2credentialprovider/${name}`;
  const apiKeyArn = (name: string) => `${ARN_BASE}/apikeycredentialprovider/${name}`;
  const paymentArn = (name: string) => `${ARN_BASE}/paymentcredentialprovider/${name}`;

  beforeEach(() => {
    mockGetCredentialProvider.mockReturnValue({});
    mockDeleteOAuth2Provider.mockResolvedValue({ success: true });
    mockDeleteApiKeyProvider.mockResolvedValue({ success: true });
  });

  afterEach(() => vi.clearAllMocks());

  it('deletes an OAuth2 provider no longer in the spec, routing by ARN', async () => {
    const result = await reconcileCredentialProviders({
      region: 'us-east-1',
      priorCredentials: { 'my-harness-oauth': { credentialProviderArn: oauth2Arn('my-harness-oauth') } },
      retainedCredentialNames: new Set(),
    });

    expect(mockDeleteOAuth2Provider).toHaveBeenCalledWith(expect.anything(), 'my-harness-oauth');
    expect(mockDeleteApiKeyProvider).not.toHaveBeenCalled();
    expect(result.deleted).toEqual(['my-harness-oauth']);
    expect(result.errors).toEqual([]);
  });

  it('deletes an ApiKey provider no longer in the spec, routing by ARN', async () => {
    const result = await reconcileCredentialProviders({
      region: 'us-east-1',
      priorCredentials: { 'gemini-key': { credentialProviderArn: apiKeyArn('gemini-key') } },
      retainedCredentialNames: new Set(),
    });

    expect(mockDeleteApiKeyProvider).toHaveBeenCalledWith(expect.anything(), 'gemini-key');
    expect(mockDeleteOAuth2Provider).not.toHaveBeenCalled();
    expect(result.deleted).toEqual(['gemini-key']);
  });

  it('keeps providers still referenced by the spec', async () => {
    const result = await reconcileCredentialProviders({
      region: 'us-east-1',
      priorCredentials: {
        'kept-oauth': { credentialProviderArn: oauth2Arn('kept-oauth') },
        'gone-oauth': { credentialProviderArn: oauth2Arn('gone-oauth') },
      },
      retainedCredentialNames: new Set(['kept-oauth']),
    });

    expect(mockDeleteOAuth2Provider).toHaveBeenCalledTimes(1);
    expect(mockDeleteOAuth2Provider).toHaveBeenCalledWith(expect.anything(), 'gone-oauth');
    expect(result.deleted).toEqual(['gone-oauth']);
  });

  it('never touches payment provider ARNs (handled separately)', async () => {
    const result = await reconcileCredentialProviders({
      region: 'us-east-1',
      priorCredentials: { 'pay-cred': { credentialProviderArn: paymentArn('pay-cred') } },
      retainedCredentialNames: new Set(),
    });

    expect(mockDeleteOAuth2Provider).not.toHaveBeenCalled();
    expect(mockDeleteApiKeyProvider).not.toHaveBeenCalled();
    expect(result.deleted).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('collects delete failures without throwing', async () => {
    mockDeleteOAuth2Provider.mockResolvedValue({ success: false, error: new Error('quota throttled') });

    const result = await reconcileCredentialProviders({
      region: 'us-east-1',
      priorCredentials: { 'bad-oauth': { credentialProviderArn: oauth2Arn('bad-oauth') } },
      retainedCredentialNames: new Set(),
    });

    expect(result.deleted).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.providerName).toBe('bad-oauth');
    expect(result.errors[0]!.error.message).toBe('quota throttled');
  });

  it('deletes all recorded providers on teardown (empty retained set)', async () => {
    const result = await reconcileCredentialProviders({
      region: 'us-east-1',
      priorCredentials: {
        'h-oauth': { credentialProviderArn: oauth2Arn('h-oauth') },
        'k-key': { credentialProviderArn: apiKeyArn('k-key') },
      },
      retainedCredentialNames: new Set(),
    });

    expect(mockDeleteOAuth2Provider).toHaveBeenCalledWith(expect.anything(), 'h-oauth');
    expect(mockDeleteApiKeyProvider).toHaveBeenCalledWith(expect.anything(), 'k-key');
    expect(result.deleted).toEqual(expect.arrayContaining(['h-oauth', 'k-key']));
    expect(result.deleted).toHaveLength(2);
  });
});
