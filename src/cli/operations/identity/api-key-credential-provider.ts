/**
 * Imperative AWS SDK operations for API key credential providers.
 *
 * This file exists because AgentCore Identity resources are not yet modeled
 * as CDK constructs. These operations run as a pre-deploy step outside the
 * main CDK synthesis/deploy path.
 */
import { type Result, toError } from '@/lib';
import { err, ok } from '@/lib/result';
import {
  BedrockAgentCoreControlClient,
  CreateApiKeyCredentialProviderCommand,
  GetApiKeyCredentialProviderCommand,
  ResourceNotFoundException,
  SetTokenVaultCMKCommand,
  UpdateApiKeyCredentialProviderCommand,
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
): Promise<Result<{ credentialProviderArn?: string }>> {
  try {
    await client.send(
      new CreateApiKeyCredentialProviderCommand({
        name: providerName,
        apiKey: apiKey,
      })
    );
    // Create response doesn't include credentialProviderArn — fetch it
    const getResponse = await client.send(new GetApiKeyCredentialProviderCommand({ name: providerName }));
    return ok({ credentialProviderArn: getResponse.credentialProviderArn });
  } catch (error) {
    const errorName = (error as { name?: string }).name;
    if (errorName === 'ConflictException' || errorName === 'ResourceAlreadyExistsException') {
      try {
        const getResponse = await client.send(new GetApiKeyCredentialProviderCommand({ name: providerName }));
        return ok({ credentialProviderArn: getResponse.credentialProviderArn });
      } catch {
        return ok();
      }
    }
    return err(toError(error));
  }
}

/**
 * Update an existing API key credential provider with a new API key.
 */
export async function updateApiKeyProvider(
  client: BedrockAgentCoreControlClient,
  providerName: string,
  apiKey: string
): Promise<Result<{ credentialProviderArn?: string }>> {
  try {
    await client.send(
      new UpdateApiKeyCredentialProviderCommand({
        name: providerName,
        apiKey: apiKey,
      })
    );
    // Update response doesn't include credentialProviderArn — fetch it
    const getResponse = await client.send(new GetApiKeyCredentialProviderCommand({ name: providerName }));
    return ok({ credentialProviderArn: getResponse.credentialProviderArn });
  } catch (error) {
    return err(toError(error));
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
): Promise<Result> {
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
    return ok();
  } catch (error) {
    return err(toError(error));
  }
}
