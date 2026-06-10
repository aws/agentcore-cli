import { cleanupStaleCredentialProviders } from './utils/credential-provider-cleanup';
import { getLogger } from './utils/logger';
import { cleanUpOldStacks } from './utils/stack-cleanup';
import { BedrockAgentCoreControlClient } from '@aws-sdk/client-bedrock-agentcore-control';
import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import type { TestProject } from 'vitest/node';

/**
 * Global setup for the e2e test project.
 *
 * The returned function runs once after all e2e tests complete.
 *
 * @see https://vitest.dev/config/#globalsetup
 */
export default async function setup(_project: TestProject): Promise<() => void> {
  const region = process.env.AWS_REGION ?? 'us-east-1';
  const logger = getLogger('global-setup');
  logger.info(`starting global setup in region: ${region}`);
  logger.info(`cleaning up stale stacks...`);

  const startTime = Date.now();

  const cfn = new CloudFormationClient({ region: region, maxAttempts: 10 });
  try {
    await cleanUpOldStacks(cfn, logger.child('stack-cleanup'));
  } catch (e) {
    logger.error(String(e));
    logger.warn(`skipping the rest of stack cleanup due to fatal error`);
  } finally {
    cfn.destroy();
  }

  const stackCleanUpFinishTime = Date.now();
  logger.info(`done cleaning up stacks after ${(stackCleanUpFinishTime - startTime) / 1000} seconds`);
  logger.info(`cleaning up stale credential providers...`);
  const bedrockCPClient = new BedrockAgentCoreControlClient({ region: region, maxAttempts: 10 });

  try {
    await cleanupStaleCredentialProviders(bedrockCPClient, logger.child('credential-provider-cleanup'), {
      minAgeMs: 30 * 60 * 1000,
      prefix: 'E2e',
    });
  } catch (e) {
    logger.error(String(e));
    logger.warn(`failed to clean up all credential providers`);
  } finally {
    bedrockCPClient.destroy();
  }

  logger.info(`setup finished in ${(Date.now() - startTime) / 1000} seconds`);

  return function teardown(): void {
    // one time cleanup runs here.
  };
}
