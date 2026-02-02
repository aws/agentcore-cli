/**
 * Imperative AWS SDK operations for API key credential providers.
 *
 * This file exists because AgentCore Identity resources are not yet modeled
 * as CDK constructs. These operations run as a pre-deploy step outside the
 * main CDK synthesis/deploy path.
 */
import {
  BedrockAgentCoreControlClient,
  CreateApiKeyCredentialProviderCommand,
  GetApiKeyCredentialProviderCommand,
  ResourceNotFoundException,
  SetTokenVaultCMKCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';

/**
 * Check if an API key credential provider exists.
 */
export async function apiKeyProviderExists(
  client: BedrockAgentCoreControlClient,
  providerName: string
): Promise<boolean> {
  try {
    await client.send(new GetApiKeyCredentialProviderCommand({ name: providerName }));
    return true;
  } catch (error) {
    if (error instanceof ResourceNotFoundException) {
      return false;
    }
    throw error;
  }
}

/**
 * Create an API key credential provider.
 * Returns success even if provider already exists (idempotent).
 */
export async function createApiKeyProvider(
  client: BedrockAgentCoreControlClient,
  providerName: string,
  apiKey: string
): Promise<{ success: boolean; error?: string }> {
  try {
    await client.send(
      new CreateApiKeyCredentialProviderCommand({
        name: providerName,
        apiKey: apiKey,
      })
    );
    return { success: true };
  } catch (error) {
    const errorName = (error as { name?: string }).name;
    if (errorName === 'ConflictException' || errorName === 'ResourceAlreadyExistsException') {
      return { success: true };
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Configure KMS encryption for the token vault.
 * This encrypts all API key credential providers stored in the vault.
 */
export async function setTokenVaultKmsKey(
  client: BedrockAgentCoreControlClient,
  kmsKeyArn: string,
  tokenVaultId?: string
): Promise<{ success: boolean; error?: string }> {
  try {
    await client.send(
      new SetTokenVaultCMKCommand({
        tokenVaultId,
        kmsConfiguration: {
          keyType: 'CustomerManagedKey',
          kmsKeyArn,
        },
      })
    );
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
