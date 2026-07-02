import type { ConfigIO } from '../../../lib';
import type { AgentCoreProjectSpec } from '../../../schema';
import { isContainerBuild } from '../../../schema/constants';
import { resolveVpcIdFromSubnets } from '../../commands/shared/vpc-utils';

export interface BackfillVpcIdResult {
  /** Names of runtimes/harnesses whose vpcId was resolved and persisted this run. */
  backfilled: string[];
}

/**
 * Backfill `networkConfig.vpcId` for any Container+VPC runtime or harness that is missing it, then
 * persist the change to disk so CDK synth (a separate process that re-reads agentcore.json /
 * harness.json) sees the resolved value.
 *
 * vpcId became required for Container+VPC builds after this feature shipped, but agentcore.json
 * files written before then have only subnets + security groups. Rather than hard-fail those
 * configs on read, deploy resolves the VPC from the first subnet via ec2:DescribeSubnets — a subnet
 * uniquely determines its VPC — and writes it back once. Fresh creates already collect --vpc-id at
 * the CLI layer, so this is a no-op for them.
 *
 * @returns the names that were backfilled (empty if none needed it).
 */
export async function backfillContainerVpcIds(
  configIO: ConfigIO,
  projectSpec: AgentCoreProjectSpec,
  region: string
): Promise<BackfillVpcIdResult> {
  const backfilled: string[] = [];

  // Runtimes live inline in agentcore.json; mutate the spec and write it back once at the end if any
  // changed.
  let runtimesChanged = false;
  for (const runtime of projectSpec.runtimes ?? []) {
    const nc = runtime.networkConfig;
    if (isContainerBuild(runtime) && runtime.networkMode === 'VPC' && nc && nc.subnets.length > 0 && !nc.vpcId) {
      nc.vpcId = await resolveVpcIdFromSubnets(nc.subnets, region);
      runtimesChanged = true;
      backfilled.push(runtime.name);
    }
  }
  if (runtimesChanged) {
    await configIO.writeProjectSpec(projectSpec);
  }

  // Harnesses live in their own harness.json files; resolve + persist each independently.
  for (const entry of projectSpec.harnesses ?? []) {
    const harness = await configIO.readHarnessSpec(entry.name);
    const nc = harness.networkConfig;
    if (isContainerBuild(harness) && harness.networkMode === 'VPC' && nc && nc.subnets.length > 0 && !nc.vpcId) {
      nc.vpcId = await resolveVpcIdFromSubnets(nc.subnets, region);
      await configIO.writeHarnessSpec(entry.name, harness);
      backfilled.push(entry.name);
    }
  }

  return { backfilled };
}
