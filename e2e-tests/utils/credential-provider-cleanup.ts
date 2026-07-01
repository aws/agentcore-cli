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
 * Delete stale OAuth2 credential providers matching `prefix` and older than `minAgeMs`.
 *
 * OAuth2 providers are a distinct resource type from API key providers — they have their
 * own List/Delete APIs and do NOT appear in ListApiKeyCredentialProviders. So
 * `cleanupStaleCredentialProviders` (which lists only API key providers) can never reap
 * them. The CUSTOM_JWT harness e2e test registers a managed OAuth2 provider (`<name>-oauth`)
 * that is created outside the CloudFormation stack, so teardown leaves it behind. Without
 * this reaper they accumulate against the account's 50-provider OAuth2 quota (L-431051DC)
 * until every CUSTOM_JWT deploy fails with a limit-reached error.
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
