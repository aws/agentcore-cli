import { AwsCredentialsError } from '../../../../lib/errors/types.js';
import { isAccountMismatch, resolveAwsIdentity } from '../aws-identity.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockDetectAccount = vi.fn();

vi.mock('../../../aws', () => ({
  detectAccount: (...args: unknown[]) => mockDetectAccount(...args),
}));

describe('resolveAwsIdentity', () => {
  let originalProfile: string | undefined;

  beforeEach(() => {
    originalProfile = process.env.AWS_PROFILE;
    delete process.env.AWS_PROFILE;
    mockDetectAccount.mockReset();
  });

  afterEach(() => {
    if (originalProfile === undefined) delete process.env.AWS_PROFILE;
    else process.env.AWS_PROFILE = originalProfile;
  });

  it('returns the account and the AWS_PROFILE in use', async () => {
    process.env.AWS_PROFILE = 'dev';
    mockDetectAccount.mockResolvedValue('123456789012');

    expect(await resolveAwsIdentity()).toEqual({ success: true, account: '123456789012', profile: 'dev' });
  });

  it('calls STS in the given region', async () => {
    mockDetectAccount.mockResolvedValue('123456789012');

    await resolveAwsIdentity('cn-north-1');
    expect(mockDetectAccount).toHaveBeenCalledWith('cn-north-1');
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
      error: 'No AWS credentials found.',
    });
  });

  it('uses the short message of an AwsCredentialsError', async () => {
    process.env.AWS_PROFILE = 'expired';
    mockDetectAccount.mockRejectedValue(
      new AwsCredentialsError('AWS credentials expired.', 'AWS credentials expired.\n\nTo fix this: ...')
    );

    expect(await resolveAwsIdentity()).toEqual({
      success: false,
      profile: 'expired',
      error: 'AWS credentials expired.',
    });
  });

  it('reports unexpected errors without throwing', async () => {
    mockDetectAccount.mockRejectedValue(new Error('network down'));

    expect(await resolveAwsIdentity()).toEqual({ success: false, profile: undefined, error: 'network down' });
  });
});

describe('isAccountMismatch', () => {
  it('is true only when both accounts are known and differ', () => {
    expect(isAccountMismatch({ success: true, account: '111111111111' }, '222222222222')).toBe(true);
    expect(isAccountMismatch({ success: true, account: '111111111111' }, '111111111111')).toBe(false);
    expect(isAccountMismatch({ success: true, account: '111111111111' }, undefined)).toBe(false);
    expect(isAccountMismatch({ success: false, error: 'No AWS credentials found.' }, '222222222222')).toBe(false);
  });
});
