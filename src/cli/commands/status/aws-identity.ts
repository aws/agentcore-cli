import { AwsCredentialsError } from '../../../lib';
import { detectAccount, hasEnvCredentials } from '../../aws';
import { getErrorMessage } from '../../errors';
import { AWS_IDENTITY_TIMEOUT_MS } from './constants';

export interface AwsIdentityStatus {
  success: boolean;
  account?: string;
  /** Set only when AWS_PROFILE is the credential source; access keys in the environment take precedence. */
  profile?: string;
  fromEnvironment: boolean;
  error?: string;
}

/**
 * Resolves the account of the active AWS credentials. Never throws: credential problems are returned in `error`.
 */
export async function resolveAwsIdentity(region?: string): Promise<AwsIdentityStatus> {
  const fromEnvironment = hasEnvCredentials();
  const profile = !fromEnvironment && process.env.AWS_PROFILE?.length ? process.env.AWS_PROFILE : undefined;
  try {
    const account = await detectAccount({ region, timeoutMs: AWS_IDENTITY_TIMEOUT_MS });
    return account
      ? { success: true, account, profile, fromEnvironment }
      : { success: false, profile, fromEnvironment, error: 'No AWS credentials found.' };
  } catch (error) {
    return {
      success: false,
      profile,
      fromEnvironment,
      error: error instanceof AwsCredentialsError ? error.shortMessage : getErrorMessage(error),
    };
  }
}

export function isAccountMismatch(identity: AwsIdentityStatus, targetAccount?: string): boolean {
  return !!identity.account && !!targetAccount && identity.account !== targetAccount;
}
