import { getAwsLoginGuidance } from '../external-requirements/checks';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { fromEnv, fromNodeProviderChain } from '@aws-sdk/credential-providers';
import type { AwsCredentialIdentityProvider } from '@smithy/types';

/**
 * Get the AWS credential provider to use for SDK clients.
 * Prioritizes environment variables when set, otherwise uses the full provider chain.
 * This ensures proper credential resolution without requiring ~/.aws directory.
 */
export function getCredentialProvider(): AwsCredentialIdentityProvider {
  const hasEnvCreds = process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY;
  return hasEnvCreds ? fromEnv() : fromNodeProviderChain();
}

/**
 * Error thrown when AWS credentials are not configured or invalid.
 * Supports both a short message (for interactive mode) and detailed message (for CLI mode).
 */
export class AwsCredentialsError extends Error {
  /** Short message suitable for interactive mode where UI handles recovery */
  readonly shortMessage: string;

  constructor(shortMessage: string, detailedMessage?: string) {
    super(detailedMessage ?? shortMessage);
    this.name = 'AwsCredentialsError';
    this.shortMessage = shortMessage;
  }
}

/**
 * Error thrown when AWS credentials are for a different account than the target.
 */
export class AccountMismatchError extends Error {
  readonly credentialsAccount: string;
  readonly targetAccount: string;
  readonly targetName: string;

  constructor(credentialsAccount: string, targetAccount: string, targetName: string) {
    super(
      `AWS credentials are for account ${credentialsAccount}, but target "${targetName}" ` +
        `is configured for account ${targetAccount}.\n\n` +
        `To fix this:\n` +
        `  1. Switch to credentials for account ${targetAccount}\n` +
        `  2. Or update aws-targets.json to use account ${credentialsAccount}`
    );
    this.name = 'AccountMismatchError';
    this.credentialsAccount = credentialsAccount;
    this.targetAccount = targetAccount;
    this.targetName = targetName;
  }
}

/**
 * Get AWS account ID using STS GetCallerIdentity with detailed error handling.
 * Throws AwsCredentialsError with helpful messages for common credential issues.
 * Returns null only for unexpected errors (triggers generic "no credentials" message).
 */
export async function detectAccount(): Promise<string | null> {
  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1';

  try {
    const client = new STSClient({
      credentials: getCredentialProvider(),
      region,
    });
    const response = await client.send(new GetCallerIdentityCommand({}));
    return response.Account ?? null;
  } catch (err) {
    const code = (err as { name?: string })?.name ?? (err as { Code?: string })?.Code;

    if (code === 'ExpiredTokenException' || code === 'ExpiredToken') {
      const guidance = await getAwsLoginGuidance();
      throw new AwsCredentialsError(
        'AWS credentials expired.',
        `AWS credentials expired.\n\nTo fix this:\n  ${guidance}`
      );
    }

    if (code === 'InvalidClientTokenId' || code === 'SignatureDoesNotMatch') {
      const guidance = await getAwsLoginGuidance();
      throw new AwsCredentialsError(
        'AWS credentials are invalid.',
        `AWS credentials are invalid.\n\nTo fix this:\n  1. Check your AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY\n  2. Or ${guidance}`
      );
    }

    if (code === 'AccessDenied' || code === 'AccessDeniedException') {
      throw new AwsCredentialsError(
        'AWS credentials lack required permissions.',
        'AWS credentials lack required permissions for STS:GetCallerIdentity.\n\nTo fix this:\n  Ensure your IAM user/role has sts:GetCallerIdentity permission'
      );
    }

    return null;
  }
}

/**
 * Validate that AWS credentials are configured and working.
 * Throws AwsCredentialsError with a helpful message if not.
 */
export async function validateAwsCredentials(): Promise<void> {
  const account = await detectAccount();
  if (!account) {
    const guidance = await getAwsLoginGuidance();
    throw new AwsCredentialsError(
      'No AWS credentials configured.',
      'No AWS credentials configured.\n\n' +
        'To fix this:\n' +
        `  1. ${guidance}\n` +
        '  2. Or set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY environment variables'
    );
  }
}

/**
 * Validate that the current AWS credentials match the target account.
 * Throws AccountMismatchError if there's a mismatch.
 * Throws AwsCredentialsError if no credentials are configured.
 */
export async function validateAccountMatch(targetAccount: string, targetName: string): Promise<void> {
  const credentialsAccount = await detectAccount();
  if (!credentialsAccount) {
    // No credentials - throw AwsCredentialsError
    const guidance = await getAwsLoginGuidance();
    throw new AwsCredentialsError(
      'No AWS credentials configured.',
      'No AWS credentials configured.\n\n' +
        'To fix this:\n' +
        `  1. ${guidance}\n` +
        '  2. Or set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY environment variables'
    );
  }

  if (credentialsAccount !== targetAccount) {
    throw new AccountMismatchError(credentialsAccount, targetAccount, targetName);
  }
}
