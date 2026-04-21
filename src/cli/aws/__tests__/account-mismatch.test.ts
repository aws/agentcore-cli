import { AccountMismatchError, AwsCredentialsError, validateAccountMatch } from '../account.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

describe('AccountMismatchError', () => {
  it('includes both account IDs in message', () => {
    const err = new AccountMismatchError('111111111111', '222222222222', 'prod');
    expect(err.message).toContain('111111111111');
    expect(err.message).toContain('222222222222');
    expect(err.message).toContain('prod');
  });

  it('has correct name', () => {
    const err = new AccountMismatchError('111111111111', '222222222222', 'test');
    expect(err.name).toBe('AccountMismatchError');
  });

  it('is an instance of Error', () => {
    expect(new AccountMismatchError('111', '222', 'test')).toBeInstanceOf(Error);
  });

  it('stores account IDs and target name as properties', () => {
    const err = new AccountMismatchError('111111111111', '222222222222', 'prod');
    expect(err.credentialsAccount).toBe('111111111111');
    expect(err.targetAccount).toBe('222222222222');
    expect(err.targetName).toBe('prod');
  });

  it('includes fix instructions in message', () => {
    const err = new AccountMismatchError('111111111111', '222222222222', 'prod');
    expect(err.message).toContain('To fix this');
    expect(err.message).toContain('Switch to credentials');
    expect(err.message).toContain('update aws-targets.json');
  });
});

describe('validateAccountMatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('succeeds when accounts match', async () => {
    mockSend.mockResolvedValue({ Account: '123456789012' });
    await expect(validateAccountMatch('123456789012', 'default')).resolves.toBeUndefined();
  });

  it('throws AccountMismatchError when accounts differ', async () => {
    mockSend.mockResolvedValue({ Account: '111111111111' });
    await expect(validateAccountMatch('222222222222', 'prod')).rejects.toThrow(AccountMismatchError);
  });

  it('throws AccountMismatchError with correct properties when accounts differ', async () => {
    mockSend.mockResolvedValue({ Account: '111111111111' });
    try {
      await validateAccountMatch('222222222222', 'prod');
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AccountMismatchError);
      const mismatchErr = err as AccountMismatchError;
      expect(mismatchErr.credentialsAccount).toBe('111111111111');
      expect(mismatchErr.targetAccount).toBe('222222222222');
      expect(mismatchErr.targetName).toBe('prod');
    }
  });

  it('throws AwsCredentialsError when no credentials (detectAccount returns null)', async () => {
    // When detectAccount returns null (unknown error), validateAccountMatch should throw AwsCredentialsError
    mockSend.mockRejectedValue(new Error('Unknown error'));
    await expect(validateAccountMatch('123456789012', 'default')).rejects.toThrow(AwsCredentialsError);
    await expect(validateAccountMatch('123456789012', 'default')).rejects.toThrow('No AWS credentials configured');
  });

  it('propagates AwsCredentialsError from detectAccount for expired tokens', async () => {
    const expiredError = new Error('Token expired');
    Object.defineProperty(expiredError, 'name', { value: 'ExpiredTokenException', writable: true });
    mockSend.mockRejectedValue(expiredError);

    await expect(validateAccountMatch('123456789012', 'default')).rejects.toThrow(AwsCredentialsError);
    await expect(validateAccountMatch('123456789012', 'default')).rejects.toThrow('expired');
  });
});
