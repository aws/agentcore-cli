import { AwsCredentialsError } from '../../../lib';
import { detectAccount } from '../../aws';
import { getErrorMessage } from '../../errors';

export interface AwsIdentityStatus {
  success: boolean;
  account?: string;
  profile?: string;
  error?: string;
}

/**
 * Resolves the account of the active AWS credentials. Never throws: credential problems are returned in `error`.
 */
export async function resolveAwsIdentity(region?: string): Promise<AwsIdentityStatus> {
  const profile = process.env.AWS_PROFILE?.length ? process.env.AWS_PROFILE : undefined;
  try {
    const account = await detectAccount(region);
    return account
      ? { success: true, account, profile }
      : { success: false, profile, error: 'No AWS credentials found.' };
  } catch (error) {
    return {
      success: false,
      profile,
      error: error instanceof AwsCredentialsError ? error.shortMessage : getErrorMessage(error),
    };
  }
}

export function isAccountMismatch(identity: AwsIdentityStatus, targetAccount?: string): boolean {
  return !!identity.account && !!targetAccount && identity.account !== targetAccount;
}
