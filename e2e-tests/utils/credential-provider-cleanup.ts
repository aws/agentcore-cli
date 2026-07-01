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

/**
 * Delete stale credential providers matching `prefix` and older than `minAgeMs`.
 *
 * Reaps BOTH provider types the e2e suite creates: API key providers and OAuth2 providers.
 * These are distinct resource types with separate List/Delete APIs — an OAuth2 provider does
 * NOT appear in ListApiKeyCredentialProviders — so both lists must be walked. The CUSTOM_JWT
 * harness test registers a managed OAuth2 provider (`<name>-oauth`) created outside the
 * CloudFormation stack, so teardown leaves it behind; without reaping it here, they accumulate
 * against the account's 50-provider OAuth2 quota (L-431051DC) until every CUSTOM_JWT deploy
 * fails with a limit-reached error.
 */
export async function cleanupStaleCredentialProviders(
  client: BedrockAgentCoreControlClient,
  logger: Logger,
  options: {
    minAgeMs: number;
    prefix: string;
  }
): Promise<void> {
  const cutoff = new Date(Date.now() - options.minAgeMs);
  const isStale = (p: { name?: string; createdTime?: Date }): boolean =>
    !!p.name?.startsWith(options.prefix) && !!p.createdTime && p.createdTime < cutoff;

  let apiKeyNextToken: string | undefined;
  do {
    const response = await client.send(new ListApiKeyCredentialProvidersCommand({ nextToken: apiKeyNextToken }));
    const stale = (response.credentialProviders ?? []).filter(isStale);
    await Promise.all(stale.map(p => deleteCredentialProvider(client, logger, p.name!)));
    apiKeyNextToken = response.nextToken;
  } while (apiKeyNextToken);

  let oauth2NextToken: string | undefined;
  do {
    const response = await client.send(new ListOauth2CredentialProvidersCommand({ nextToken: oauth2NextToken }));
    const stale = (response.credentialProviders ?? []).filter(isStale);
    await Promise.all(stale.map(p => deleteOAuth2CredentialProvider(client, logger, p.name!)));
    oauth2NextToken = response.nextToken;
  } while (oauth2NextToken);
}
