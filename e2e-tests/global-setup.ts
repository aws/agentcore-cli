import {
  CloudFormationClient,
  DeleteStackCommand,
  StackStatus,
  type StackSummary,
  paginateListStacks,
  waitUntilStackDeleteComplete,
} from '@aws-sdk/client-cloudformation';
import type { TestProject } from 'vitest/node';

const REGION = process.env.AWS_REGION ?? 'us-east-1';

const getLogger = (prefix = `[global-setup]`) => ({
  info: (msg: string) => console.info(`${prefix}: ${msg}`),
  warn: (msg: string) => console.warn(`${prefix}: ${msg}`),
  error: (msg: string) => console.error(`${prefix}: ${msg}`),
});

/**
 * List every root stack whose name starts with given prefix and is older than given age, with an optional filter.
 */
async function listStacks(
  cfn: CloudFormationClient,
  options: { maxCount?: number; minStackAgeMs: number; statusFilter?: (status: StackStatus) => boolean; prefix: string }
): Promise<StackSummary[]> {
  const cutoff = new Date(Date.now() - options.minStackAgeMs);
  getLogger().info(`listing stacks with cutoff=${cutoff.toISOString()}, prefix=${options.prefix}`);

  const stacks: StackSummary[] = [];
  for await (const page of paginateListStacks(
    { client: cfn },
    {
      StackStatusFilter: Object.values(StackStatus).filter(options.statusFilter ?? (() => true)),
    }
  )) {
    for (const summary of page.StackSummaries ?? []) {
      if (options.maxCount !== undefined && stacks.length >= options.maxCount) return stacks;
      if (!summary.StackName?.startsWith(options.prefix)) continue;
      if (summary.ParentId) continue; // skip nested stacks.
      if (!summary.CreationTime || summary.CreationTime > cutoff) continue;
      stacks.push(summary);
    }
  }
  return stacks;
}

/**
 * Delete a single stack and block until CloudFormation confirms it is gone.
 * Skip cleanups that fail.
 */
async function deleteStackAndVerify(cfn: CloudFormationClient, stackName: string): Promise<boolean> {
  await cfn.send(new DeleteStackCommand({ StackName: stackName }));
  getLogger().info(`deleting stack with name ${stackName}`);
  const startTime = Date.now();
  try {
    const result = await waitUntilStackDeleteComplete(
      { client: cfn, maxWaitTime: 60 * 3, minDelay: 15 },
      { StackName: stackName }
    );

    getLogger().info(`finished deleting stack in ${(Date.now() - startTime) / 1000} seconds`);

    if (String(result.state) === 'SUCCESS') {
      return true;
    }
  } catch (e) {
    const err = e as Error;
    getLogger().error(`failed to delete stack with name ${stackName} after ${(Date.now() - startTime) / 1000} seconds`);
    getLogger().error(`skipping stack after error: ${err.name}:${err.message}`);
  }

  // DELETE_FAILED, timed out, or otherwise did not reach DELETE_COMPLETE.
  return false;
}

async function cleanUpOldStacks(
  client: CloudFormationClient,
  options?: { maxStacksDeleted?: number; retries?: number }
) {
  const logger = getLogger();
  const stacks = await listStacks(client, {
    statusFilter: s =>
      ![StackStatus.DELETE_COMPLETE, StackStatus.DELETE_IN_PROGRESS].includes(s as never) &&
      !s.toString().endsWith('_IN_PROGRESS'),
    prefix: 'AgentCore-E2e',
    minStackAgeMs: 3 * 60 * 60 * 1000,
    maxCount: options?.maxStacksDeleted,
  });
  logger.info(`found ${stacks.length} stacks`);
  if (stacks.length === 0) {
    logger.info(`no stacks found!`);
  } else {
    const names = stacks.map(s => s.StackName!);

    logger.info(`deleting ${names.length} stacks with names=${names.join(',')}`);
    const results = await Promise.allSettled(names.map(name => deleteStackAndVerify(client, name)));
    const passed = results.filter(p => p.status === 'fulfilled' && p.value);
    logger.info(`deleted ${passed.length} of ${names.length} remaining stacks`);

    if (options?.retries !== undefined && options.retries > 0 && passed.length !== names.length) {
      await cleanUpOldStacks(client, { ...options, retries: options.retries - 1 });
    }
  }
}

/**
 * Global setup for the e2e test project.
 *
 * The returned function runs once after all e2e tests complete.
 *
 * @see https://vitest.dev/config/#globalsetup
 */
export default async function setup(_project: TestProject): Promise<() => void> {
  getLogger().info(`starting global setup in region: ${REGION}`);

  const cfn = new CloudFormationClient({ region: REGION, maxAttempts: 10 });
  try {
    await cleanUpOldStacks(cfn);
  } catch (e) {
    getLogger().error(String(e));
    getLogger().warn(`skipping the rest of stack cleanup due to fatal error`);
  } finally {
    cfn.destroy();
  }
  return function teardown(): void {
    // one time cleanup runs here.
  };
}
