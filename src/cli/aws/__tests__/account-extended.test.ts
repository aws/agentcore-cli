import { AwsCredentialsError, TimeoutError, ValidationError } from '../../../lib/errors/types.js';
import { detectAccount, getCredentialProvider, hasEnvCredentials, validateAwsCredentials } from '../account.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSend, mockStsConfig } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockStsConfig: vi.fn(),
}));

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: class {
    send = mockSend;
    constructor(config: unknown) {
      mockStsConfig(config);
    }
  },
  GetCallerIdentityCommand: class {
    constructor(public input: unknown) {}
  },
}));

vi.mock('@aws-sdk/credential-providers', () => ({
  fromEnv: vi.fn().mockReturnValue({}),
  fromNodeProviderChain: vi.fn().mockReturnValue({}),
}));

function makeNamedError(message: string, name: string): Error {
  const err = new Error(message);
  Object.defineProperty(err, 'name', { value: name, writable: true });
  return err;
}

describe('getCredentialProvider', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns a credential provider (function)', () => {
    const provider = getCredentialProvider();
    expect(provider).toBeDefined();
  });
});

describe('hasEnvCredentials', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('is true only when both access key variables are set', () => {
    process.env.AWS_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
    process.env.AWS_SECRET_ACCESS_KEY = 'secret';
    expect(hasEnvCredentials()).toBe(true);

    delete process.env.AWS_SECRET_ACCESS_KEY;
    expect(hasEnvCredentials()).toBe(false);
  });
});

describe('detectAccount', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns account ID on success', async () => {
    mockSend.mockResolvedValue({ Account: '123456789012' });

    const account = await detectAccount();
    expect(account).toBe('123456789012');
  });

  it('calls STS in the given region instead of the environment region', async () => {
    mockSend.mockResolvedValue({ Account: '123456789012' });

    await detectAccount({ region: 'us-gov-west-1' });
    expect(mockStsConfig).toHaveBeenCalledWith(expect.objectContaining({ region: 'us-gov-west-1' }));
  });

  it('keeps the SDK retry and timeout defaults when no timeout is given', async () => {
    mockSend.mockResolvedValue({ Account: '123456789012' });

    await detectAccount();
    const config = mockStsConfig.mock.calls[0]![0] as Record<string, unknown>;
    expect(config).not.toHaveProperty('maxAttempts');
    expect(config).not.toHaveProperty('requestHandler');
  });

  it('makes a single bounded attempt when a timeout is given', async () => {
    mockSend.mockResolvedValue({ Account: '123456789012' });

    await detectAccount({ timeoutMs: 3000 });
    expect(mockStsConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        maxAttempts: 1,
        requestHandler: { connectionTimeout: 3000, requestTimeout: 3000, throwOnRequestTimeout: true },
      })
    );
  });

  it('throws TimeoutError when the bounded attempt times out', async () => {
    mockSend.mockRejectedValue(makeNamedError('socket timed out', 'TimeoutError'));

    await expect(detectAccount({ timeoutMs: 3000 })).rejects.toThrow(TimeoutError);
    await expect(detectAccount({ timeoutMs: 3000 })).rejects.toThrow('Timed out resolving the AWS account after 3s.');
  });

  it('returns null when Account is undefined', async () => {
    mockSend.mockResolvedValue({ Account: undefined });

    const account = await detectAccount();
    expect(account).toBeNull();
  });

  it('throws AwsCredentialsError for ExpiredTokenException', async () => {
    mockSend.mockRejectedValue(makeNamedError('Token expired', 'ExpiredTokenException'));

    await expect(detectAccount()).rejects.toThrow(AwsCredentialsError);
    await expect(detectAccount()).rejects.toThrow('expired');
  });

  it('throws AwsCredentialsError for ExpiredToken', async () => {
    mockSend.mockRejectedValue(makeNamedError('Token expired', 'ExpiredToken'));

    await expect(detectAccount()).rejects.toThrow(AwsCredentialsError);
  });

  it('throws AwsCredentialsError for InvalidClientTokenId', async () => {
    mockSend.mockRejectedValue(makeNamedError('Invalid token', 'InvalidClientTokenId'));

    await expect(detectAccount()).rejects.toThrow(AwsCredentialsError);
    await expect(detectAccount()).rejects.toThrow('invalid');
  });

  it('throws AwsCredentialsError for SignatureDoesNotMatch', async () => {
    mockSend.mockRejectedValue(makeNamedError('Sig mismatch', 'SignatureDoesNotMatch'));

    await expect(detectAccount()).rejects.toThrow(AwsCredentialsError);
  });

  it('throws AwsCredentialsError for AccessDenied', async () => {
    mockSend.mockRejectedValue(makeNamedError('Access denied', 'AccessDenied'));

    await expect(detectAccount()).rejects.toThrow(AwsCredentialsError);
    await expect(detectAccount()).rejects.toThrow('permissions');
  });

  it('throws AwsCredentialsError for AccessDeniedException', async () => {
    mockSend.mockRejectedValue(makeNamedError('Access denied', 'AccessDeniedException'));

    await expect(detectAccount()).rejects.toThrow(AwsCredentialsError);
  });

  it('returns null for unknown errors', async () => {
    mockSend.mockRejectedValue(new Error('Unknown error'));

    const account = await detectAccount();
    expect(account).toBeNull();
  });
});

describe('validateAwsCredentials', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not throw when credentials are valid', async () => {
    mockSend.mockResolvedValue({ Account: '123456789012' });

    await expect(validateAwsCredentials()).resolves.toBeUndefined();
  });

  it('does not throw when credentials match the deployment target', async () => {
    mockSend.mockResolvedValue({ Account: '123456789012' });

    await expect(validateAwsCredentials({ name: 'prod', account: '123456789012' })).resolves.toBeUndefined();
  });

  it('throws a clear error when credentials do not match the deployment target', async () => {
    mockSend.mockResolvedValue({ Account: '111111111111' });

    const validation = validateAwsCredentials({ name: 'prod', account: '222222222222' });
    await expect(validation).rejects.toBeInstanceOf(ValidationError);
    await expect(validation).rejects.toThrow(
      'Your AWS credentials are for account 111111111111, but the target "prod" is configured for account 222222222222.'
    );
  });

  it('throws AwsCredentialsError when detectAccount returns null', async () => {
    mockSend.mockRejectedValue(new Error('something'));

    await expect(validateAwsCredentials()).rejects.toThrow(AwsCredentialsError);
    await expect(validateAwsCredentials()).rejects.toThrow('No AWS credentials configured');
  });
});
