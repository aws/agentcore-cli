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
    const code = (error as { name?: string }).name ?? 'Unknown';
    logger.warn(`Failed to delete credential provider ${name}: [${code}]`);
  }
}

export async function cleanupStaleCredentialProviders(
  client: BedrockAgentCoreControlClient,
  logger: Logger,
  maxAgeMs: number = 30 * 60 * 1000
): Promise<void> {
  const cutoff = new Date(Date.now() - maxAgeMs);

  let nextToken: string | undefined;
  do {
    const response = await client.send(new ListApiKeyCredentialProvidersCommand({ nextToken }));
    const providers = response.credentialProviders ?? [];
    const stale = providers.filter(p => p.name?.startsWith('E2e') && p.createdTime && p.createdTime < cutoff);

    await Promise.all(stale.map(p => deleteCredentialProvider(client, logger, p.name!)));

    nextToken = response.nextToken;
  } while (nextToken);
}
