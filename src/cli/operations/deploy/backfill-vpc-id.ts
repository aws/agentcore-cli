import type { ConfigIO } from '../../../lib';
import type { AgentCoreProjectSpec } from '../../../schema';
import { isContainerBuild } from '../../../schema/constants';
import { resolveVpcIdFromSubnets } from '../../commands/shared/vpc-utils';
import { readFile, writeFile } from 'fs/promises';

export interface BackfillVpcIdResult {
  /** Names of runtimes/harnesses whose vpcId was resolved this run. */
  backfilled: string[];
  /**
   * Restore the config files this call rewrote to their original on-disk bytes. Populated only when
   * `persist` is false (dry-run/plan): the value is still written to disk so the CDK synth subprocess
   * can read it, then reverted so a preview leaves the working tree untouched. No-op on a real deploy.
   *
   * Best-effort and total: it attempts every rewritten file even if one revert fails, then throws an
   * aggregate error if any did. Safe to call more than once.
   */
  restore: () => Promise<void>;
}

/**
 * Backfill `networkConfig.vpcId` for any Container+VPC runtime or harness that is missing it.
 *
 * vpcId became required for Container+VPC builds after this feature shipped, but agentcore.json
 * files written before then have only subnets + security groups. Rather than hard-fail those
 * configs on read, deploy resolves the VPC from the first subnet via ec2:DescribeSubnets — a subnet
 * uniquely determines its VPC. Fresh creates already collect --vpc-id at the CLI layer, so this is a
 * no-op for them.
 *
 * CDK synth is a separate process that re-reads agentcore.json / harness.json from disk, so the
 * resolved value must be written there. On a real deploy (`persist: true`) the write is permanent.
 * On a preview (`persist: false` — dry-run/plan) the write is temporary: the returned `restore()`
 * reverts the files after synth, honoring the "preview without deploying" contract.
 *
 * A preview write is ALWAYS revertible, even on a mid-run failure: if resolution throws after one or
 * more files were already rewritten (e.g. a second Container+VPC resource whose subnets span VPCs or
 * whose DescribeSubnets is throttled), the partial writes are rolled back before the error
 * propagates — so a failed preview never leaves the working tree dirty.
 *
 * @returns the names that were backfilled and a `restore()` callback (a no-op when persist is true).
 */
export async function backfillContainerVpcIds(
  configIO: ConfigIO,
  projectSpec: AgentCoreProjectSpec,
  region: string,
  persist = true
): Promise<BackfillVpcIdResult> {
  const backfilled: string[] = [];
  // path -> original bytes, captured before the first rewrite of each file (preview mode only, so
  // restore() can revert them). Never populated on a real deploy (persist=true).
  const originals = new Map<string, string>();

  // Snapshot a file's current bytes before we rewrite it — preview mode only, once per path.
  const snapshot = async (path: string): Promise<void> => {
    if (persist || originals.has(path)) return;
    originals.set(path, await readFile(path, 'utf-8'));
  };

  // Revert every rewritten file to its snapshot. Best-effort/total: attempts each path even if a
  // prior one fails, then throws an aggregate so callers (e.g. a deploy `finally`) still run their
  // other cleanup. No-op on a real deploy (nothing snapshotted).
  const restore = async (): Promise<void> => {
    const failures: string[] = [];
    for (const [path, content] of originals) {
      try {
        await writeFile(path, content, 'utf-8');
      } catch (err) {
        failures.push(`${path}: ${(err as Error).message ?? String(err)}`);
      }
    }
    if (failures.length > 0) {
      throw new Error(`Failed to restore ${failures.length} config file(s) after preview: ${failures.join('; ')}`);
    }
  };

  try {
    // Runtimes live inline in agentcore.json; mutate the spec and write it back once at the end if
    // any changed.
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
      await snapshot(configIO.getAgentConfigPath());
      await configIO.writeProjectSpec(projectSpec);
    }

    // Harnesses live in their own harness.json files; resolve + persist each independently.
    for (const entry of projectSpec.harnesses ?? []) {
      const harness = await configIO.readHarnessSpec(entry.name);
      const nc = harness.networkConfig;
      if (isContainerBuild(harness) && harness.networkMode === 'VPC' && nc && nc.subnets.length > 0 && !nc.vpcId) {
        nc.vpcId = await resolveVpcIdFromSubnets(nc.subnets, region);
        await snapshot(configIO.getHarnessConfigPath(entry.name));
        await configIO.writeHarnessSpec(entry.name, harness);
        backfilled.push(entry.name);
      }
    }
  } catch (err) {
    // A resolve/write failed partway through a preview — roll back any files we already rewrote so
    // the working tree is clean, then propagate. (No-op on a real deploy: nothing was snapshotted.)
    await restore().catch(() => {
      /* preserve the original error over a secondary restore failure */
    });
    throw err;
  }

  return { backfilled, restore };
}
