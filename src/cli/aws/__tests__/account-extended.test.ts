import { AwsCredentialsError, detectAccount, getCredentialProvider, validateAwsCredentials } from '../account.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSend } = vi.hoisted(() => ({
  mockSend: vi.fn(),
}));

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: class {
    send = mockSend;
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

describe('detectAccount', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns account ID on success', async () => {
    mockSend.mockResolvedValue({ Account: '123456789012' });

    const account = await detectAccount();
    expect(account).toBe('123456789012');
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

  it('throws AwsCredentialsError when detectAccount returns null', async () => {
    mockSend.mockRejectedValue(new Error('something'));

    await expect(validateAwsCredentials()).rejects.toThrow(AwsCredentialsError);
    await expect(validateAwsCredentials()).rejects.toThrow('No AWS credentials configured');
  });
});
