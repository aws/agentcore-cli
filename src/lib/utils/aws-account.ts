import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';

/**
 * Detect AWS account ID from current credentials using STS GetCallerIdentity.
 * This call always succeeds if credentials are valid (cannot be denied by IAM).
 * Returns null if credentials are not available or invalid.
 */
export async function detectAwsAccount(): Promise<string | null> {
  try {
    const client = new STSClient({
      credentials: fromNodeProviderChain(),
      region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1',
    });
    const response = await client.send(new GetCallerIdentityCommand({}));
    return response.Account ?? null;
  } catch {
    return null;
  }
}
