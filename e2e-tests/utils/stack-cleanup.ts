import type { Logger } from './logger';
import {
  type CloudFormationClient,
  DeleteStackCommand,
  StackStatus,
  type StackSummary,
  paginateListStacks,
  waitUntilStackDeleteComplete,
} from '@aws-sdk/client-cloudformation';

/**
 * List every root stack whose name starts with given prefix and is older than given age, with an optional filter.
 */
async function listStacks(
  cfn: CloudFormationClient,
  logger: Logger,
  options: { maxCount?: number; minStackAgeMs: number; statusFilter?: (status: StackStatus) => boolean; prefix: string }
): Promise<StackSummary[]> {
  const cutoff = new Date(Date.now() - options.minStackAgeMs);
  logger.info(`listing stacks with cutoff=${cutoff.toISOString()}, prefix=${options.prefix}`);

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
async function deleteStackAndVerify(cfn: CloudFormationClient, logger: Logger, stackName: string): Promise<boolean> {
  await cfn.send(new DeleteStackCommand({ StackName: stackName }));
  logger.info(`deleting stack with name ${stackName}`);
  const startTime = Date.now();
  try {
    const result = await waitUntilStackDeleteComplete(
      { client: cfn, maxWaitTime: 60 * 3, minDelay: 15 },
      { StackName: stackName }
    );

    logger.info(`finished deleting stack in ${(Date.now() - startTime) / 1000} seconds`);

    if (String(result.state) === 'SUCCESS') {
      return true;
    }
  } catch (e) {
    const err = e as Error;
    logger.error(`failed to delete stack with name ${stackName} after ${(Date.now() - startTime) / 1000} seconds`);
    logger.error(`skipping stack after error: ${err.name}:${err.message}`);
  }

  // DELETE_FAILED, timed out, or otherwise did not reach DELETE_COMPLETE.
  return false;
}

export async function cleanUpOldStacks(
  client: CloudFormationClient,
  logger: Logger,
  options?: { maxStacksDeleted?: number; retries?: number }
) {
  const stacks = await listStacks(client, logger, {
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
    const results = await Promise.allSettled(names.map(name => deleteStackAndVerify(client, logger, name)));
    const passed = results.filter(p => p.status === 'fulfilled' && p.value);
    logger.info(`deleted ${passed.length} of ${names.length} remaining stacks`);

    if (options?.retries !== undefined && options.retries > 0 && passed.length !== names.length) {
      await cleanUpOldStacks(client, logger, { ...options, retries: options.retries - 1 });
    }
  }
}
