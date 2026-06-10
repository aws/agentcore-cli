import type { Logger } from './logger';
import {
  BedrockAgentCoreControlClient,
  DeleteApiKeyCredentialProviderCommand,
  ListApiKeyCredentialProvidersCommand,
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
