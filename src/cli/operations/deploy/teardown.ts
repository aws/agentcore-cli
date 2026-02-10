import { CONFIG_DIR, ConfigIO } from '../../../lib';
import type { AwsDeploymentTarget } from '../../../schema';
import { CdkToolkitWrapper, silentIoHost } from '../../cdk/toolkit-lib';
import { type DiscoveredStack, findStack } from '../../cloudformation/stack-discovery';
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
  const targets = await configIO.readAWSDeploymentTargets();

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
  });

  await toolkit.initialize();
  await toolkit.destroy({
    stacks: {
      strategy: StackSelectionStrategy.PATTERN_MUST_MATCH,
      patterns: [target.stack.stackName],
    },
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

export interface StackTeardownResult {
  success: boolean;
  error?: string;
}

/**
 * Perform full stack teardown for a target: destroy CloudFormation stack,
 * remove deployed-state entry, and remove the target from aws-targets.json.
 */
export async function performStackTeardown(targetName: string): Promise<StackTeardownResult> {
  const cdkProjectDir = getCdkProjectDir();
  const configIO = new ConfigIO();

  const discovered = await discoverDeployedTargets();
  const deployedTarget = discovered.deployedTargets.find(dt => dt.target.name === targetName);
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
  const remainingTargets = (await configIO.readAWSDeploymentTargets()).filter(t => t.name !== targetName);
  await configIO.writeAWSDeploymentTargets(remainingTargets);

  return { success: true };
}
