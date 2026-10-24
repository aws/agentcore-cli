import { AwsCredentialsError, TimeoutError } from '../../../../lib/errors/types.js';
import { isAccountMismatch, resolveAwsIdentity } from '../aws-identity.js';
import { AWS_IDENTITY_TIMEOUT_MS } from '../constants.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockDetectAccount = vi.fn();
const mockHasEnvCredentials = vi.fn();

vi.mock('../../../aws', () => ({
  detectAccount: (...args: unknown[]) => mockDetectAccount(...args),
  hasEnvCredentials: () => mockHasEnvCredentials(),
}));

describe('resolveAwsIdentity', () => {
  let originalProfile: string | undefined;

  beforeEach(() => {
    originalProfile = process.env.AWS_PROFILE;
    delete process.env.AWS_PROFILE;
    mockDetectAccount.mockReset();
    mockHasEnvCredentials.mockReset().mockReturnValue(false);
  });

  afterEach(() => {
    if (originalProfile === undefined) delete process.env.AWS_PROFILE;
    else process.env.AWS_PROFILE = originalProfile;
  });

  it('returns the account and the AWS_PROFILE in use', async () => {
    process.env.AWS_PROFILE = 'dev';
    mockDetectAccount.mockResolvedValue('123456789012');

    expect(await resolveAwsIdentity()).toEqual({
      success: true,
      account: '123456789012',
      profile: 'dev',
      fromEnvironment: false,
    });
  });

  it('calls STS in the given region with a bounded timeout', async () => {
    mockDetectAccount.mockResolvedValue('123456789012');

    await resolveAwsIdentity('cn-north-1');
    expect(mockDetectAccount).toHaveBeenCalledWith({ region: 'cn-north-1', timeoutMs: AWS_IDENTITY_TIMEOUT_MS });
  });

  it('reports environment credentials instead of an AWS_PROFILE they override', async () => {
    process.env.AWS_PROFILE = 'dev';
    mockHasEnvCredentials.mockReturnValue(true);
    mockDetectAccount.mockResolvedValue('123456789012');

    expect(await resolveAwsIdentity()).toEqual({
      success: true,
      account: '123456789012',
      profile: undefined,
      fromEnvironment: true,
    });
  });

  it('treats an empty AWS_PROFILE as unset', async () => {
    process.env.AWS_PROFILE = '';
    mockDetectAccount.mockResolvedValue('123456789012');

    expect((await resolveAwsIdentity()).profile).toBeUndefined();
  });

  it('reports missing credentials without throwing', async () => {
    mockDetectAccount.mockResolvedValue(null);

    expect(await resolveAwsIdentity()).toEqual({
      success: false,
      profile: undefined,
      fromEnvironment: false,
      error: 'No AWS credentials found.',
    });
  });

  it('uses the short message of an AwsCredentialsError', async () => {
    process.env.AWS_PROFILE = 'expired';
    mockDetectAccount.mockRejectedValue(
      new AwsCredentialsError('AWS credentials expired.', 'AWS credentials expired.\n\nTo fix this: ...')
    );

    expect(await resolveAwsIdentity()).toMatchObject({
      success: false,
      profile: 'expired',
      error: 'AWS credentials expired.',
    });
  });

  it('reports a timeout without throwing', async () => {
    mockDetectAccount.mockRejectedValue(new TimeoutError('Timed out resolving the AWS account after 3s.'));

    expect(await resolveAwsIdentity()).toMatchObject({
      success: false,
      error: 'Timed out resolving the AWS account after 3s.',
    });
  });

  it('reports unexpected errors without throwing', async () => {
    mockDetectAccount.mockRejectedValue(new Error('network down'));

    expect(await resolveAwsIdentity()).toMatchObject({ success: false, error: 'network down' });
  });
});

describe('isAccountMismatch', () => {
  const resolved = { success: true, account: '111111111111', fromEnvironment: false };

  it('is true only when both accounts are known and differ', () => {
    expect(isAccountMismatch(resolved, '222222222222')).toBe(true);
    expect(isAccountMismatch(resolved, '111111111111')).toBe(false);
    expect(isAccountMismatch(resolved, undefined)).toBe(false);
    expect(
      isAccountMismatch({ success: false, fromEnvironment: false, error: 'No AWS credentials found.' }, '222222222222')
    ).toBe(false);
  });
});
