import { CONFIG_DIR, ConfigIO } from '../../../lib';
import type { Result } from '../../../lib/result';
import type { AwsDeploymentTarget } from '../../../schema';
import { withTargetRegion } from '../../aws';
import { deleteConfigurationBundle } from '../../aws/agentcore-config-bundles';
import { deleteHarness, isHarnessNotFoundError } from '../../aws/agentcore-harness';
import { CdkToolkitWrapper, silentIoHost } from '../../cdk/toolkit-lib';
import { type DiscoveredStack, findStack } from '../../cloudformation/stack-discovery';
import { findOrphanHarnesses } from '../harness/orphan';
import { StackSelectionStrategy } from '@aws-cdk/toolkit-lib';
import { existsSync } from 'fs';
import { join } from 'path';

export interface DeployedTarget {
  target: AwsDeploymentTarget;
  stack: DiscoveredStack;
}

export interface DiscoverDeployedResult {
  projectName: string;
  deployedTargets: DeployedTarget[];
}

/**
 * Discover all deployed stacks for the current project.
 * Returns targets that have corresponding CloudFormation stacks.
 */
export async function discoverDeployedTargets(configBaseDir?: string): Promise<DiscoverDeployedResult> {
  const configIO = new ConfigIO(configBaseDir ? { baseDir: configBaseDir } : undefined);
  const projectSpec = await configIO.readProjectSpec();
  const targets = await configIO.resolveAWSDeploymentTargets();

  const deployedTargets: DeployedTarget[] = [];
  for (const target of targets) {
    try {
      const stack = await findStack(target.region, projectSpec.name, target.name);
      if (stack) {
        deployedTargets.push({ target, stack });
      }
    } catch {
      // Ignore errors checking individual targets (e.g., no credentials)
    }
  }

  return { projectName: projectSpec.name, deployedTargets };
}

export interface DestroyTargetOptions {
  target: DeployedTarget;
  cdkProjectDir: string;
}

/**
 * Destroy a specific target's CloudFormation stack and clean up local state.
 */
export async function destroyTarget(options: DestroyTargetOptions): Promise<void> {
  const { target, cdkProjectDir } = options;

  if (!existsSync(cdkProjectDir)) {
    throw new Error('CDK project not found. Cannot destroy without CDK project.');
  }

  const toolkit = new CdkToolkitWrapper({
    projectDir: cdkProjectDir,
    ioHost: silentIoHost,
    region: target.target.region,
  });

  // aws-targets.json is authoritative for the destroy region; promote it onto
  // the env so CDK toolkit-lib's internal SDK clients hit the right region even
  // when AWS_REGION / AWS_DEFAULT_REGION are unset.
  // See https://github.com/aws/agentcore-cli/issues/924.
  await withTargetRegion(target.target.region, async () => {
    await toolkit.initialize();
    await toolkit.destroy({
      stacks: {
        strategy: StackSelectionStrategy.PATTERN_MUST_MATCH,
        patterns: [target.stack.stackName],
      },
    });
  });

  // Clean up deployed-state.json after successful destroy
  const configIO = new ConfigIO();
  try {
    const deployedState = await configIO.readDeployedState();
    if (deployedState.targets[target.target.name]) {
      delete deployedState.targets[target.target.name];
      await configIO.writeDeployedState(deployedState);
    }
  } catch {
    // Ignore errors reading/writing deployed state
  }
}

/**
 * Get the CDK project directory path.
 */
export function getCdkProjectDir(cwd?: string): string {
  const baseDir = cwd ?? process.cwd();
  return join(baseDir, CONFIG_DIR, 'cdk');
}

/**
 * Perform full stack teardown for a target: destroy CloudFormation stack,
 * remove deployed-state entry, and remove the target from aws-targets.json.
 */
export async function performStackTeardown(targetName: string): Promise<Result> {
  const cdkProjectDir = getCdkProjectDir();
  const configIO = new ConfigIO();

  const discovered = await discoverDeployedTargets();
  const deployedTarget = discovered.deployedTargets.find(dt => dt.target.name === targetName);

  // Clean up imperatively-created resources before stack destruction.
  // Ordering: AB tests first (they create rules on gateways), then gateways, then bundles.
  // Delegates to the existing orphan-cleanup functions with an empty spec so everything
  // is treated as orphaned — reuses stop/poll/delete/role-cleanup logic without duplication.
  try {
    const deployedState = await configIO.readDeployedState();
    const resources = deployedState.targets?.[targetName]?.resources;

    // Delete imperative-build orphan harnesses. CloudFormation never created them so the stack
    // destroy below won't touch them, and teardown removes the deployed-state they're recorded in —
    // so a post-teardown `remove harness --discard` could no longer find them, leaving them running
    // and billing forever. Teardown means "remove everything", so delete them here (using the
    // recorded id+region, never re-resolving by name). 404 = already gone (success); other errors
    // warn but don't abort the teardown.
    for (const orphan of findOrphanHarnesses(deployedState, undefined).filter(o => o.targetName === targetName)) {
      try {
        await deleteHarness({ region: orphan.region, harnessId: orphan.harnessId });
        console.log(`Deleted preview-build harness "${orphan.name}"`);
      } catch (err) {
        if (isHarnessNotFoundError(err)) {
          // Already gone — nothing to do.
        } else {
          console.warn(
            `Warning: Could not delete preview-build harness "${orphan.name}" (${orphan.harnessId}) in ` +
              `${orphan.region}: ${err instanceof Error ? err.message : String(err)}. Delete it manually to stop incurring cost.`
          );
        }
      }
    }

    if (resources?.configBundles) {
      let region = deployedTarget?.target.region;
      if (!region) {
        try {
          const targets = await configIO.resolveAWSDeploymentTargets();
          const matchingTarget = targets.find(t => t.name === targetName);
          region = matchingTarget?.region;
        } catch {
          // Can't resolve region
        }
      }
      if (!region) {
        console.warn('Warning: Could not determine region for resource cleanup — resources may need manual deletion');
      }
      if (region) {
        for (const [bundleName, bundleState] of Object.entries(resources.configBundles ?? {})) {
          try {
            await deleteConfigurationBundle({ region, bundleId: bundleState.bundleId });
            console.log(`Deleted config bundle "${bundleName}"`);
          } catch (err) {
            console.warn(
              `Warning: Error during config bundle "${bundleName}" cleanup: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
      }
    }
  } catch (err) {
    // Only suppress "file not found" — other errors (corrupt state, permissions) should warn
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('ENOENT') && !msg.includes('not found') && !msg.includes('does not exist')) {
      console.warn(`Warning: Could not read deployed state for resource cleanup: ${msg}`);
    }
  }

  if (deployedTarget) {
    await destroyTarget({ target: deployedTarget, cdkProjectDir });
  }

  // Clean up deployed-state.json first (it validates against aws-targets.json),
  // then remove the target from aws-targets.json.
  // readDeployedState throws if the file doesn't exist, which is fine — skip cleanup.
  // But if the file exists and we fail to write, let that error propagate.
  try {
    const deployedState = await configIO.readDeployedState();
    delete deployedState.targets[targetName];
    await configIO.writeDeployedState(deployedState);
  } catch (err) {
    // Only ignore "file not found" — rethrow anything else (e.g. write failures)
    if (err instanceof Error && (err.message.includes('ENOENT') || err.message.includes('not found'))) {
      // No deployed-state file — nothing to clean up
    } else {
      throw err;
    }
  }
  const remainingTargets = (await configIO.resolveAWSDeploymentTargets()).filter(t => t.name !== targetName);
  await configIO.writeAWSDeploymentTargets(remainingTargets);

  return { success: true };
}
