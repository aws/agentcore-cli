import { setupApiKeyProviders } from '../pre-deploy-identity.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockKmsSend, mockControlSend, mockSetTokenVaultKmsKey, mockReadEnvFile, mockGetCredentialProvider } =
  vi.hoisted(() => ({
    mockKmsSend: vi.fn(),
    mockControlSend: vi.fn(),
    mockSetTokenVaultKmsKey: vi.fn(),
    mockReadEnvFile: vi.fn(),
    mockGetCredentialProvider: vi.fn(),
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
  setTokenVaultKmsKey: mockSetTokenVaultKmsKey,
  updateApiKeyProvider: vi.fn(),
}));

vi.mock('../../identity/create-identity.js', () => ({
  computeDefaultCredentialEnvVarName: vi.fn((name: string) => `${name}_API_KEY`),
}));

vi.mock('../../../../lib/index.js', () => ({
  SecureCredentials: class {
    static fromEnvVars() {
      return {
        merge: () => ({}),
        get: () => undefined,
      };
    }
  },
  readEnvFile: mockReadEnvFile,
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
  agents: [],
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
