import { ConfigIO, DOCKERFILE_NAME, requireConfigRoot, resolveCodeLocation } from '../../../lib';
import type { AgentCoreProjectSpec, AwsDeploymentTarget } from '../../../schema';
import { validateAwsCredentials } from '../../aws/account';
import { LocalCdkProject } from '../../cdk/local-cdk-project';
import { CdkToolkitWrapper, createCdkToolkitWrapper, silentIoHost } from '../../cdk/toolkit-lib';
import { checkBootstrapStatus, checkStacksStatus, formatCdkEnvironment } from '../../cloudformation';
import { cleanupStaleLockFiles } from '../../tui/utils';
import type { IIoHost } from '@aws-cdk/toolkit-lib';
import { existsSync } from 'node:fs';
import * as path from 'node:path';

export interface PreflightContext {
  projectSpec: AgentCoreProjectSpec;
  awsTargets: AwsDeploymentTarget[];
  cdkProject: LocalCdkProject;
  /** True when agents array is empty but a deployed stack exists — deploy will tear down resources */
  isTeardownDeploy: boolean;
}

export interface SynthResult {
  toolkitWrapper: CdkToolkitWrapper;
  stackNames: string[];
}

export interface BootstrapCheckResult {
  needsBootstrap: boolean;
  target: AwsDeploymentTarget | null;
}

export interface StackStatusCheckResult {
  /** Whether all stacks are in a deployable state */
  canDeploy: boolean;
  /** The stack that is blocking deployment, if any */
  blockingStack?: string;
  /** User-friendly message explaining why deployment is blocked */
  message?: string;
}

/**
 * Format an error for user display, including stack trace if available.
 */
export function formatError(err: unknown): string {
  if (err instanceof Error) {
    const lines = [err.message];
    if (err.stack) {
      lines.push('', 'Stack trace:', err.stack);
    }
    if (err.cause) {
      lines.push('', 'Caused by:', formatError(err.cause));
    }
    return lines.join('\n');
  }
  return String(err);
}

/**
 * Validates the CDK project and loads configuration.
 * Also validates AWS credentials are configured before proceeding.
 * Returns the project context needed for subsequent steps.
 */
const MAX_RUNTIME_NAME_LENGTH = 48;

export async function validateProject(): Promise<PreflightContext> {
  // Find the agentcore config directory, walking up from cwd if needed
  const configRoot = requireConfigRoot();
  // Project root is the parent of the agentcore directory
  const projectRoot = path.dirname(configRoot);

  const cdkProject = new LocalCdkProject(projectRoot);
  cdkProject.validate();

  const configIO = new ConfigIO({ baseDir: configRoot });
  const projectSpec = await configIO.readProjectSpec();
  const awsTargets = await configIO.readAWSDeploymentTargets();

  // Validate that at least one agent is defined, unless this is a teardown deploy.
  //
  // Teardown detection: when agents is empty but deployed-state.json records existing
  // targets, the user has run `remove all` and wants to tear down AWS resources via deploy.
  // deployed-state.json is written by the CLI after every successful deploy, so it is a
  // reliable indicator of whether a CloudFormation stack exists for this project.
  let isTeardownDeploy = false;
  if (!projectSpec.agents || projectSpec.agents.length === 0) {
    let hasExistingStack = false;
    try {
      const deployedState = await configIO.readDeployedState();
      hasExistingStack = Object.keys(deployedState.targets).length > 0;
    } catch {
      // No deployed state file — no existing stack
    }
    if (!hasExistingStack) {
      throw new Error(
        'No agents defined in project. Add at least one agent with "agentcore add agent" before deploying.'
      );
    }
    isTeardownDeploy = true;
  }

  // Validate runtime names don't exceed AWS limits
  validateRuntimeNames(projectSpec);

  // Validate Container agents have Dockerfiles
  validateContainerAgents(projectSpec, configRoot);

  // Validate AWS credentials before proceeding with build/synth.
  // Skip for teardown deploys — callers validate after teardown confirmation.
  if (!isTeardownDeploy) {
    await validateAwsCredentials();
  }

  return { projectSpec, awsTargets, cdkProject, isTeardownDeploy };
}

/**
 * Validates that combined runtime names (projectName_agentName) don't exceed AWS limits.
 */
function validateRuntimeNames(projectSpec: AgentCoreProjectSpec): void {
  const projectName = projectSpec.name;
  for (const agent of projectSpec.agents) {
    const agentName = agent.name;
    if (agentName) {
      const combinedName = `${projectName}_${agentName}`;
      if (combinedName.length > MAX_RUNTIME_NAME_LENGTH) {
        throw new Error(
          `Runtime name too long: "${combinedName}" (${combinedName.length} chars). ` +
            `AWS limits runtime names to ${MAX_RUNTIME_NAME_LENGTH} characters. ` +
            `Shorten the project name or agent name in agentcore.json.`
        );
      }
    }
  }
}

/**
 * Validates that Container agents have required Dockerfiles.
 */
export function validateContainerAgents(projectSpec: AgentCoreProjectSpec, configRoot: string): void {
  const errors: string[] = [];
  for (const agent of projectSpec.agents) {
    if (agent.build === 'Container') {
      const codeLocation = resolveCodeLocation(agent.codeLocation, configRoot);
      const dockerfilePath = path.join(codeLocation, DOCKERFILE_NAME);

      if (!existsSync(dockerfilePath)) {
        errors.push(
          `Agent "${agent.name}": Dockerfile not found at ${dockerfilePath}. Container agents require a Dockerfile.`
        );
      }
    }
  }
  if (errors.length > 0) {
    throw new Error(errors.join('\n'));
  }
}

/**
 * Builds the CDK project.
 */
export async function buildCdkProject(cdkProject: LocalCdkProject): Promise<void> {
  await cdkProject.build();
}

export interface SynthOptions {
  /** Custom IoHost for capturing CDK output. Defaults to silentIoHost. */
  ioHost?: IIoHost;
  /** Previous toolkit wrapper to dispose before synthesis. */
  previousWrapper?: CdkToolkitWrapper | null;
}

/**
 * Synthesizes CloudFormation templates from the CDK project.
 * Disposes previous wrapper and cleans up stale lock files before synthesis.
 */
export async function synthesizeCdk(cdkProject: LocalCdkProject, options?: SynthOptions): Promise<SynthResult> {
  // Dispose previous wrapper to release CDK lock files
  if (options?.previousWrapper) {
    await options.previousWrapper.dispose();
  }

  // Clean up stale lock files from dead processes before CDK operations
  const cdkOutDir = path.join(cdkProject.projectDir, 'cdk.out');
  await cleanupStaleLockFiles(cdkOutDir);

  // Use provided ioHost or default to silentIoHost to prevent CDK output from interfering with TUI
  const toolkitWrapper = await createCdkToolkitWrapper({
    projectDir: cdkProject.projectDir,
    ioHost: options?.ioHost ?? silentIoHost,
  });

  // synth() produces the assembly internally and stores the directory for later use
  const synthResult = await toolkitWrapper.synth();

  return {
    toolkitWrapper,
    stackNames: synthResult.stackNames,
  };
}

/**
 * Checks if the CloudFormation stacks are in a deployable state.
 * Returns information about any stack that would block deployment.
 */
export async function checkStackDeployability(region: string, stackNames: string[]): Promise<StackStatusCheckResult> {
  const blocking = await checkStacksStatus(region, stackNames);

  if (blocking) {
    return {
      canDeploy: false,
      blockingStack: blocking.stackName,
      message: blocking.result.message,
    };
  }

  return { canDeploy: true };
}

/**
 * Checks if AWS environment needs bootstrapping.
 * Returns the target that needs bootstrapping, or null if already bootstrapped.
 */
export async function checkBootstrapNeeded(awsTargets: AwsDeploymentTarget[]): Promise<BootstrapCheckResult> {
  const target = awsTargets[0];
  if (!target) {
    return { needsBootstrap: false, target: null };
  }

  try {
    const bootstrapStatus = await checkBootstrapStatus(target.region);
    if (!bootstrapStatus.isBootstrapped) {
      return { needsBootstrap: true, target };
    }
  } catch {
    // If we can't check bootstrap status, continue without bootstrapping
    // The deploy will fail with a clearer error
  }

  return { needsBootstrap: false, target: null };
}

/**
 * Bootstraps the AWS environment using the CDK toolkit.
 * CDK bootstrap automatically creates a KMS CMK for S3 bucket encryption.
 */
export async function bootstrapEnvironment(
  toolkitWrapper: CdkToolkitWrapper,
  target: AwsDeploymentTarget
): Promise<void> {
  const env = formatCdkEnvironment(target.account, target.region);
  await toolkitWrapper.bootstrap([env]);
}
