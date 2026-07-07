import { handleValidate } from '../action.js';
import assert from 'node:assert';
import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  mockReadProjectSpec,
  mockReadAWSDeploymentTargets,
  mockReadDeployedState,
  mockConfigExists,
  mockFindConfigRoot,
  mockExistsSync,
  mockReadEnvFile,
  mockSecureCredentialsGet,
} = vi.hoisted(() => ({
  mockReadProjectSpec: vi.fn(),
  mockReadAWSDeploymentTargets: vi.fn(),
  mockReadDeployedState: vi.fn(),
  mockConfigExists: vi.fn(),
  mockFindConfigRoot: vi.fn(),
  mockExistsSync: vi.fn(),
  mockReadEnvFile: vi.fn(),
  mockSecureCredentialsGet: vi.fn(),
}));

vi.mock('fs', () => ({
  existsSync: mockExistsSync,
}));

vi.mock('../../../../lib/index.js', () => {
  class NoProjectError extends Error {
    constructor(msg?: string) {
      super(msg ?? 'No agentcore project found');
      this.name = 'NoProjectError';
    }
  }

  class ConfigValidationError extends Error {}
  class ConfigParseError extends Error {
    constructor(
      public readonly filePath: string,
      public override readonly cause: unknown
    ) {
      super(`Parse error at ${filePath}`);
    }
  }
  class ConfigReadError extends Error {
    constructor(
      public readonly filePath: string,
      public override readonly cause: unknown
    ) {
      super(`Read error at ${filePath}`);
    }
  }
  class ConfigNotFoundError extends Error {
    constructor(
      public readonly filePath: string,
      public readonly fileType: string
    ) {
      super(`${fileType} not found at ${filePath}`);
    }
  }

  class SecureCredentials {
    static fromEnvVars(_vars: Record<string, string>) {
      return new SecureCredentials();
    }
    get(key: string) {
      return mockSecureCredentialsGet(key);
    }
  }

  return {
    ConfigIO: class {
      readProjectSpec = mockReadProjectSpec;
      readAWSDeploymentTargets = mockReadAWSDeploymentTargets;
      readDeployedState = mockReadDeployedState;
      configExists = mockConfigExists;
    },
    ConfigValidationError,
    ConfigParseError,
    ConfigReadError,
    ConfigNotFoundError,
    NoProjectError,
    findConfigRoot: mockFindConfigRoot,
    readEnvFile: mockReadEnvFile,
    SecureCredentials,
  };
});

describe('handleValidate', () => {
  afterEach(() => vi.clearAllMocks());

  it('returns error when no project found', async () => {
    mockFindConfigRoot.mockReturnValue(null);

    const result = await handleValidate({});

    expect(result.success).toBe(false);
    assert(!result.success);
    expect(result.error.message).toContain('No agentcore project found');
  });

  it('returns success when all configs are valid', async () => {
    mockFindConfigRoot.mockReturnValue('/project/agentcore');
    mockReadProjectSpec.mockResolvedValue({ name: 'Test', version: 1, managedBy: 'CDK' as const, runtimes: [] });
    mockReadAWSDeploymentTargets.mockResolvedValue([]);
    mockConfigExists.mockReturnValue(false);

    const result = await handleValidate({});

    expect(result.success).toBe(true);
  });

  it('returns error when project spec fails', async () => {
    mockFindConfigRoot.mockReturnValue('/project/agentcore');
    mockReadProjectSpec.mockRejectedValue(new Error('invalid project'));

    const result = await handleValidate({});

    expect(result.success).toBe(false);
    assert(!result.success);
    expect(result.error.message).toContain('invalid project');
  });

  it('returns error when AWS targets fails', async () => {
    mockFindConfigRoot.mockReturnValue('/project/agentcore');
    mockReadProjectSpec.mockResolvedValue({ name: 'Test', version: 1, managedBy: 'CDK' as const, runtimes: [] });
    mockReadAWSDeploymentTargets.mockRejectedValue(new Error('bad targets'));

    const result = await handleValidate({});

    expect(result.success).toBe(false);
    assert(!result.success);
    expect(result.error.message).toContain('bad targets');
  });

  it('validates state file when it exists', async () => {
    mockFindConfigRoot.mockReturnValue('/project/agentcore');
    mockReadProjectSpec.mockResolvedValue({ name: 'Test', version: 1, managedBy: 'CDK' as const, runtimes: [] });
    mockReadAWSDeploymentTargets.mockResolvedValue([]);
    mockConfigExists.mockReturnValue(true);
    mockReadDeployedState.mockResolvedValue({ targets: {} });

    const result = await handleValidate({});

    expect(result.success).toBe(true);
    expect(mockReadDeployedState).toHaveBeenCalled();
  });

  it('returns error when state file is invalid', async () => {
    mockFindConfigRoot.mockReturnValue('/project/agentcore');
    mockReadProjectSpec.mockResolvedValue({ name: 'Test', version: 1, managedBy: 'CDK' as const, runtimes: [] });
    mockReadAWSDeploymentTargets.mockResolvedValue([]);
    mockConfigExists.mockReturnValue(true);
    mockReadDeployedState.mockRejectedValue(new Error('bad state'));

    const result = await handleValidate({});

    expect(result.success).toBe(false);
    assert(!result.success);
    expect(result.error.message).toContain('bad state');
  });

  it('uses custom directory when provided', async () => {
    mockFindConfigRoot.mockReturnValue('/custom/agentcore');
    mockReadProjectSpec.mockResolvedValue({ name: 'Test', version: 1, managedBy: 'CDK' as const, runtimes: [] });
    mockReadAWSDeploymentTargets.mockResolvedValue([]);
    mockConfigExists.mockReturnValue(false);

    const result = await handleValidate({ directory: '/custom' });

    expect(result.success).toBe(true);
    expect(mockFindConfigRoot).toHaveBeenCalledWith('/custom');
  });

  it('formats ConfigValidationError with its message', async () => {
    mockFindConfigRoot.mockReturnValue('/project/agentcore');
    const { ConfigValidationError } = await import('../../../../lib/index.js');
    mockReadProjectSpec.mockRejectedValue(new (ConfigValidationError as any)('field "name" is required'));

    const result = await handleValidate({});

    expect(result.success).toBe(false);
    assert(!result.success);
    expect(result.error.message).toBe('field "name" is required');
  });

  it('formats ConfigParseError with cause', async () => {
    mockFindConfigRoot.mockReturnValue('/project/agentcore');
    const { ConfigParseError } = await import('../../../../lib/index.js');
    mockReadProjectSpec.mockRejectedValue(new ConfigParseError('agentcore.json', new Error('Unexpected token')));

    const result = await handleValidate({});

    expect(result.success).toBe(false);
    assert(!result.success);
    expect(result.error.message).toContain('Invalid JSON in agentcore.json');
    expect(result.error.message).toContain('Unexpected token');
  });

  it('formats ConfigReadError with cause', async () => {
    mockFindConfigRoot.mockReturnValue('/project/agentcore');
    const { ConfigReadError } = await import('../../../../lib/index.js');
    mockReadProjectSpec.mockRejectedValue(
      new ConfigReadError('agentcore.json', new Error('EACCES: permission denied'))
    );

    const result = await handleValidate({});

    expect(result.success).toBe(false);
    assert(!result.success);
    expect(result.error.message).toContain('Failed to read agentcore.json');
    expect(result.error.message).toContain('EACCES');
  });

  it('formats ConfigNotFoundError with file name', async () => {
    mockFindConfigRoot.mockReturnValue('/project/agentcore');
    const { ConfigNotFoundError } = await import('../../../../lib/index.js');
    mockReadProjectSpec.mockRejectedValue(new ConfigNotFoundError('/path/agentcore.json', 'project'));

    const result = await handleValidate({});

    expect(result.success).toBe(false);
    assert(!result.success);
    expect(result.error.message).toBe('Required file not found: agentcore.json');
  });

  it('formats non-Error values as strings', async () => {
    mockFindConfigRoot.mockReturnValue('/project/agentcore');
    mockReadProjectSpec.mockRejectedValue('string error');

    const result = await handleValidate({});

    expect(result.success).toBe(false);
    assert(!result.success);
    expect(result.error.message).toBe('string error');
  });
});

describe('payment validation', () => {
  const CONFIG_ROOT = '/project/agentcore';

  const baseSpec = {
    name: 'Test',
    version: 1,
    managedBy: 'CDK' as const,
    runtimes: [],
  };

  const coinbaseCredential = {
    name: 'my-cred',
    authorizerType: 'PaymentCredentialProvider',
    provider: 'CoinbaseCDP',
  };

  const validPaymentSpec = {
    ...baseSpec,
    credentials: [coinbaseCredential],
    payments: [
      {
        name: 'my-manager',
        connectors: [{ name: 'my-connector', credentialName: 'my-cred', provider: 'CoinbaseCDP' }],
      },
    ],
  };

  afterEach(() => vi.clearAllMocks());

  it('passes with valid config and .env.local present', async () => {
    mockFindConfigRoot.mockReturnValue(CONFIG_ROOT);
    mockReadProjectSpec.mockResolvedValue(validPaymentSpec);
    mockReadAWSDeploymentTargets.mockResolvedValue([]);
    mockConfigExists.mockReturnValue(false);
    mockExistsSync.mockReturnValue(true);
    mockReadEnvFile.mockResolvedValue({});
    // All three CoinbaseCDP vars present with real values
    mockSecureCredentialsGet.mockImplementation((key: string) => {
      const map: Record<string, string> = {
        AGENTCORE_CREDENTIAL_MY_CRED_API_KEY_ID: 'key-id',
        AGENTCORE_CREDENTIAL_MY_CRED_API_KEY_SECRET: 'key-secret',
        AGENTCORE_CREDENTIAL_MY_CRED_WALLET_SECRET: 'wallet-secret',
      };
      return map[key];
    });

    const result = await handleValidate({});

    expect(result.success).toBe(true);
  });

  it('fails when payment manager has zero connectors', async () => {
    mockFindConfigRoot.mockReturnValue(CONFIG_ROOT);
    mockReadProjectSpec.mockResolvedValue({
      ...baseSpec,
      payments: [{ name: 'empty-manager', connectors: [] }],
    });
    mockReadAWSDeploymentTargets.mockResolvedValue([]);
    mockConfigExists.mockReturnValue(false);

    const result = await handleValidate({});

    expect(result.success).toBe(false);
    assert(!result.success);
    expect(result.error.message).toContain('"empty-manager" has no connectors');
    expect(result.error.message).toContain('--manager empty-manager');
  });

  it('fails when connector references a credential that does not exist', async () => {
    mockFindConfigRoot.mockReturnValue(CONFIG_ROOT);
    mockReadProjectSpec.mockResolvedValue({
      ...baseSpec,
      credentials: [],
      payments: [
        {
          name: 'my-manager',
          connectors: [{ name: 'my-connector', credentialName: 'ghost-cred' }],
        },
      ],
    });
    mockReadAWSDeploymentTargets.mockResolvedValue([]);
    mockConfigExists.mockReturnValue(false);

    const result = await handleValidate({});

    expect(result.success).toBe(false);
    assert(!result.success);
    expect(result.error.message).toContain('"ghost-cred" which does not exist');
    expect(result.error.message).toContain('"my-connector"');
  });

  it('fails when referenced credential has wrong authorizerType', async () => {
    mockFindConfigRoot.mockReturnValue(CONFIG_ROOT);
    mockReadProjectSpec.mockResolvedValue({
      ...baseSpec,
      credentials: [{ name: 'bad-cred', authorizerType: 'OAuth2' }],
      payments: [
        {
          name: 'my-manager',
          connectors: [{ name: 'my-connector', credentialName: 'bad-cred' }],
        },
      ],
    });
    mockReadAWSDeploymentTargets.mockResolvedValue([]);
    mockConfigExists.mockReturnValue(false);

    const result = await handleValidate({});

    expect(result.success).toBe(false);
    assert(!result.success);
    expect(result.error.message).toContain('"OAuth2"');
    expect(result.error.message).toContain('"PaymentCredentialProvider"');
    expect(result.error.message).toContain('"my-connector"');
  });

  it('fails when connector provider does not match credential provider', async () => {
    mockFindConfigRoot.mockReturnValue(CONFIG_ROOT);
    mockReadProjectSpec.mockResolvedValue({
      ...baseSpec,
      credentials: [{ name: 'my-cred', authorizerType: 'PaymentCredentialProvider', provider: 'StripePrivy' }],
      payments: [
        {
          name: 'my-manager',
          connectors: [{ name: 'my-connector', credentialName: 'my-cred', provider: 'CoinbaseCDP' }],
        },
      ],
    });
    mockReadAWSDeploymentTargets.mockResolvedValue([]);
    mockConfigExists.mockReturnValue(false);

    const result = await handleValidate({});

    expect(result.success).toBe(false);
    assert(!result.success);
    expect(result.error.message).toContain('"CoinbaseCDP"');
    expect(result.error.message).toContain('"StripePrivy"');
    expect(result.error.message).toContain('"my-connector"');
  });

  it('fails with variable list when .env.local is missing and connectors exist', async () => {
    mockFindConfigRoot.mockReturnValue(CONFIG_ROOT);
    mockReadProjectSpec.mockResolvedValue(validPaymentSpec);
    mockReadAWSDeploymentTargets.mockResolvedValue([]);
    mockConfigExists.mockReturnValue(false);
    mockExistsSync.mockReturnValue(false);

    const result = await handleValidate({});

    expect(result.success).toBe(false);
    assert(!result.success);
    expect(result.error.message).toContain('.env.local not found');
    expect(result.error.message).toContain('AGENTCORE_CREDENTIAL_MY_CRED_API_KEY_ID');
    expect(result.error.message).toContain('AGENTCORE_CREDENTIAL_MY_CRED_API_KEY_SECRET');
    expect(result.error.message).toContain('AGENTCORE_CREDENTIAL_MY_CRED_WALLET_SECRET');
  });

  it('fails naming missing CoinbaseCDP vars when .env.local exists but vars are absent', async () => {
    mockFindConfigRoot.mockReturnValue(CONFIG_ROOT);
    mockReadProjectSpec.mockResolvedValue(validPaymentSpec);
    mockReadAWSDeploymentTargets.mockResolvedValue([]);
    mockConfigExists.mockReturnValue(false);
    mockExistsSync.mockReturnValue(true);
    mockReadEnvFile.mockResolvedValue({});
    // Only api key id is set; secret and wallet secret are missing
    mockSecureCredentialsGet.mockImplementation((key: string) => {
      if (key === 'AGENTCORE_CREDENTIAL_MY_CRED_API_KEY_ID') return 'key-id';
      return undefined;
    });

    const result = await handleValidate({});

    expect(result.success).toBe(false);
    assert(!result.success);
    expect(result.error.message).toContain('Missing CoinbaseCDP credentials');
    expect(result.error.message).toContain('AGENTCORE_CREDENTIAL_MY_CRED_API_KEY_SECRET');
    expect(result.error.message).toContain('AGENTCORE_CREDENTIAL_MY_CRED_WALLET_SECRET');
    expect(result.error.message).not.toContain('AGENTCORE_CREDENTIAL_MY_CRED_API_KEY_ID');
  });

  it('fails naming missing StripePrivy vars when .env.local exists but vars are absent', async () => {
    mockFindConfigRoot.mockReturnValue(CONFIG_ROOT);
    mockReadProjectSpec.mockResolvedValue({
      ...baseSpec,
      credentials: [{ name: 'stripe-cred', authorizerType: 'PaymentCredentialProvider', provider: 'StripePrivy' }],
      payments: [
        {
          name: 'stripe-manager',
          connectors: [{ name: 'stripe-connector', credentialName: 'stripe-cred', provider: 'StripePrivy' }],
        },
      ],
    });
    mockReadAWSDeploymentTargets.mockResolvedValue([]);
    mockConfigExists.mockReturnValue(false);
    mockExistsSync.mockReturnValue(true);
    mockReadEnvFile.mockResolvedValue({});
    // Only app id is present; the other three are missing
    mockSecureCredentialsGet.mockImplementation((key: string) => {
      if (key === 'AGENTCORE_CREDENTIAL_STRIPE_CRED_APP_ID') return 'app-id';
      return undefined;
    });

    const result = await handleValidate({});

    expect(result.success).toBe(false);
    assert(!result.success);
    expect(result.error.message).toContain('Missing StripePrivy credentials');
    expect(result.error.message).toContain('AGENTCORE_CREDENTIAL_STRIPE_CRED_APP_SECRET');
    expect(result.error.message).toContain('AGENTCORE_CREDENTIAL_STRIPE_CRED_AUTHORIZATION_PRIVATE_KEY');
    expect(result.error.message).toContain('AGENTCORE_CREDENTIAL_STRIPE_CRED_AUTHORIZATION_ID');
    expect(result.error.message).not.toContain('AGENTCORE_CREDENTIAL_STRIPE_CRED_APP_ID');
  });

  it('fails when credential values in .env.local are whitespace-only', async () => {
    mockFindConfigRoot.mockReturnValue(CONFIG_ROOT);
    mockReadProjectSpec.mockResolvedValue(validPaymentSpec);
    mockReadAWSDeploymentTargets.mockResolvedValue([]);
    mockConfigExists.mockReturnValue(false);
    mockExistsSync.mockReturnValue(true);
    mockReadEnvFile.mockResolvedValue({});
    // All three vars exist but contain only whitespace
    mockSecureCredentialsGet.mockReturnValue('   ');

    const result = await handleValidate({});

    expect(result.success).toBe(false);
    assert(!result.success);
    expect(result.error.message).toContain('Missing CoinbaseCDP credentials');
  });
});
