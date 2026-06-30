import type { Logger } from './logger';
import {
  BedrockAgentCoreControlClient,
  DeleteApiKeyCredentialProviderCommand,
  DeleteOauth2CredentialProviderCommand,
  ListApiKeyCredentialProvidersCommand,
  ListOauth2CredentialProvidersCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';

export async function deleteCredentialProvider(
  client: BedrockAgentCoreControlClient,
  logger: Logger,
  name: string
): Promise<void> {
  try {
    await client.send(new DeleteApiKeyCredentialProviderCommand({ name }));
    logger.info(`Deleted credential provider: ${name}`);
  } catch (error) {
    const err = error as Error;
    logger.warn(`Failed to delete credential provider ${name}: ${err.name}:${err.message}`);
  }
}

export async function deleteOAuth2CredentialProvider(
  client: BedrockAgentCoreControlClient,
  logger: Logger,
  name: string
): Promise<void> {
  try {
    await client.send(new DeleteOauth2CredentialProviderCommand({ name }));
    logger.info(`Deleted OAuth2 credential provider: ${name}`);
  } catch (error) {
    const err = error as Error;
    logger.warn(`Failed to delete OAuth2 credential provider ${name}: ${err.name}:${err.message}`);
  }
}

export async function cleanupStaleCredentialProviders(
  client: BedrockAgentCoreControlClient,
  logger: Logger,
  options: {
    minAgeMs: number;
    prefix: string;
  }
): Promise<void> {
  const cutoff = new Date(Date.now() - options.minAgeMs);

  let nextToken: string | undefined;
  do {
    const response = await client.send(new ListApiKeyCredentialProvidersCommand({ nextToken }));
    const providers = response.credentialProviders ?? [];
    const stale = providers.filter(p => p.name?.startsWith(options.prefix) && p.createdTime && p.createdTime < cutoff);

    await Promise.all(stale.map(p => deleteCredentialProvider(client, logger, p.name!)));

    nextToken = response.nextToken;
  } while (nextToken);
}

/**
 * Delete e2e OAuth2 credential providers older than `minAgeMs` matching `prefix`.
 *
 * OAuth2 providers are created imperatively as a pre-deploy step (managed OAuth
 * credentials for CUSTOM_JWT harnesses/gateways), so they live outside the CDK
 * stack — neither `remove all` nor the per-test stack teardown deletes them. A
 * leaked provider therefore persists across runs, and the account is capped at 50
 * OAuth2 credential providers (quota L-431051DC). Once the cap is hit, every
 * CreateOauth2CredentialProvider call fails with "The number of agent identity
 * Oauth2 credential providers in this account has reached its limit", failing
 * every CUSTOM_JWT deploy. Reap leftover e2e providers before starting.
 */
export async function cleanupStaleOAuth2CredentialProviders(
  client: BedrockAgentCoreControlClient,
  logger: Logger,
  options: {
    minAgeMs: number;
    prefix: string;
  }
): Promise<void> {
  const cutoff = new Date(Date.now() - options.minAgeMs);

  let nextToken: string | undefined;
  do {
    const response = await client.send(new ListOauth2CredentialProvidersCommand({ nextToken }));
    const providers = response.credentialProviders ?? [];
    const stale = providers.filter(p => p.name?.startsWith(options.prefix) && p.createdTime && p.createdTime < cutoff);

    await Promise.all(stale.map(p => deleteOAuth2CredentialProvider(client, logger, p.name!)));

    nextToken = response.nextToken;
  } while (nextToken);
}
