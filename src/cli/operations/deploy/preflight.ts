import {
  ConfigIO,
  DOCKERFILE_NAME,
  ensureBuildContextDockerignore,
  requireConfigRoot,
  resolveBuildContext,
} from '../../../lib';
import { StaleCdkConstructError, ValidationError } from '../../../lib/errors/types';
import type { AgentCoreProjectSpec, AwsDeploymentTarget } from '../../../schema';
import { validateAwsCredentials } from '../../aws/account';
import { LocalCdkProject } from '../../cdk/local-cdk-project';
import { CdkToolkitWrapper, createCdkToolkitWrapper, silentIoHost } from '../../cdk/toolkit-lib';
import { checkBootstrapStatus, checkStacksStatus, formatCdkEnvironment } from '../../cloudformation';
import { MAX_GATEWAY_NAME_LENGTH, MAX_RUNTIME_NAME_LENGTH } from '../../constants';
import { cleanupStaleLockFiles } from '../../tui/utils';
import type { IIoHost } from '@aws-cdk/toolkit-lib';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

export interface PreflightContext {
  projectSpec: AgentCoreProjectSpec;
  awsTargets: AwsDeploymentTarget[];
  cdkProject: LocalCdkProject;
  /** True when agents array is empty but a deployed stack exists — deploy will tear down resources */
  isTeardownDeploy: boolean;
  /** True when deployed-state.json has no targets — stack has never been deployed */
  isFirstDeploy: boolean;
}

export interface SynthResult {
  toolkitWrapper: CdkToolkitWrapper;
  stackNames: string[];
}

export interface BootstrapCheckResult {
  needsBootstrap: boolean;
  target: AwsDeploymentTarget | null;
}

export const MINIMUM_CDK_BOOTSTRAP_VERSION = 30;

export interface StackStatusCheckResult {
  /** Whether all stacks are in a deployable state */
  canDeploy: boolean;
  /** The stack that is blocking deployment, if any */
  blockingStack?: string;
  /** User-friendly message explaining why deployment is blocked */
  message?: string;
}

/**
 * Format an error for user display. Shows the message and the cause chain, but NOT the raw JS stack
 * trace — dumping `err.stack` (minified dist/cli/index.mjs frames) to users is noise for the common
 * case (config/validation errors). Set AGENTCORE_DEBUG=1 to include the stack trace for debugging.
 */
export function formatError(err: unknown): string {
  if (err instanceof Error) {
    const lines = [err.message];
    if (err.stack && process.env.AGENTCORE_DEBUG) {
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
 * Spec arrays whose presence means the project has something to deploy to CloudFormation.
 * Keep in sync with the resource types that emit CFN outputs (see cloudformation/outputs.ts
 * parse*Outputs). A project with none of these is empty: deploy either errors ("No resources
 * defined") or, when a stack already exists, tears it down.
 *
 * This is the single source of truth for "is the project deployable" — a new deployable primitive
 * adds its key here and every consumer stays correct. Previously this was a hand-maintained boolean
 * chain that silently drifted (configBundles and onlineEvalConfigs were both missing from it, so a
 * project containing only those was misclassified as empty). The `satisfies` clause makes a typo'd
 * or renamed key a compile error.
 */
export const DEPLOYABLE_RESOURCE_KEYS = [
  'runtimes',
  'agentCoreGateways',
  'memories',
  'knowledgeBases',
  'evaluators',
  'onlineEvalConfigs',
  'policyEngines',
  'configBundles',
  'datasets',
  'capacityProviders',
  'harnesses',
  'payments',
] as const satisfies readonly (keyof AgentCoreProjectSpec)[];

/**
 * True when the project defines at least one resource that deploys to CloudFormation.
 */
export function hasDeployableResources(spec: AgentCoreProjectSpec): boolean {
  return DEPLOYABLE_RESOURCE_KEYS.some(key => {
    const value = spec[key];
    return Array.isArray(value) && value.length > 0;
  });
}

/**
 * Validates the CDK project and loads configuration.
 * Also validates AWS credentials are configured before proceeding.
 * Returns the project context needed for subsequent steps.
 */
export async function validateProject(selectedTarget?: AwsDeploymentTarget): Promise<PreflightContext> {
  // Find the agentcore config directory, walking up from cwd if needed
  const configRoot = requireConfigRoot();
  // Project root is the parent of the agentcore directory
  const projectRoot = path.dirname(configRoot);

  const cdkProject = new LocalCdkProject(projectRoot);
  cdkProject.validate();

  const configIO = new ConfigIO({ baseDir: configRoot });

  const projectSpec = await configIO.readProjectSpec();
  const awsTargets = await configIO.resolveAWSDeploymentTargets();

  // Validate that at least one agent or gateway is defined, unless this is a teardown deploy.
  //
  // deployed-state.json is written by the CLI after every successful deploy, so it is a
  // reliable indicator of whether a CloudFormation stack exists for this project.
  let hasExistingStack = false;
  try {
    const deployedState = await configIO.readDeployedState();
    hasExistingStack = Object.keys(deployedState.targets).length > 0;
  } catch {
    // No deployed state file — no existing stack
  }

  // Teardown detection: when no deployable resources remain but deployed-state.json records
  // existing targets, the user has run `remove all` and wants to tear down AWS resources via deploy.
  let isTeardownDeploy = false;

  if (!hasDeployableResources(projectSpec)) {
    if (!hasExistingStack) {
      throw new ValidationError(
        'No resources defined in project. Add at least one resource (agent, memory, knowledge base, evaluator, or gateway) before deploying.'
      );
    }
    isTeardownDeploy = true;
  }

  // Validate runtime names don't exceed AWS limits
  validateRuntimeNames(projectSpec);

  // Validate gateway names don't exceed AWS limits
  validateGatewayNames(projectSpec);

  // Validate Container agents have Dockerfiles
  validateContainerAgents(projectSpec, configRoot);

  // Validate per-harness harness.json up front so a schema error shows its precise message
  // here instead of as an opaque "CDK synth failed" during synth. Skipped on a teardown deploy:
  // tearing down a project with a hand-broken harness.json must not be blocked by validating the
  // very files the user is discarding (mirrors the credential-skip rationale below).
  if (!isTeardownDeploy) {
    await validateHarnessSpecs(projectSpec, configRoot);
  }

  // Validate AWS credentials before proceeding with build/synth.
  // Skip for teardown deploys — callers validate after teardown confirmation.
  if (!isTeardownDeploy) {
    await validateAwsCredentials(selectedTarget ?? awsTargets[0]);
  }

  return { projectSpec, awsTargets, cdkProject, isTeardownDeploy, isFirstDeploy: !hasExistingStack };
}

/**
 * Validates that combined runtime names (projectName_agentName) don't exceed AWS limits.
 */
function validateRuntimeNames(projectSpec: AgentCoreProjectSpec): void {
  const projectName = projectSpec.name;
  for (const agent of projectSpec.runtimes || []) {
    const agentName = agent.name;
    if (agentName) {
      const combinedName = `${projectName}_${agentName}`;
      if (combinedName.length > MAX_RUNTIME_NAME_LENGTH) {
        throw new ValidationError(
          `Runtime name too long: "${combinedName}" (${combinedName.length} chars). ` +
            `AWS limits runtime names to ${MAX_RUNTIME_NAME_LENGTH} characters. ` +
            `Shorten the project name or agent name in agentcore.json.`
        );
      }
    }
  }
}

/**
 * Validates that combined gateway names (projectName-gatewayName) don't exceed AWS limits.
 * The deployed gateway resource name is `${projectName}-${gatewayName}` and AWS rejects names
 * over 48 chars at CreateGateway — surface that here instead of as an opaque CREATE_FAILED.
 */
export function validateGatewayNames(projectSpec: AgentCoreProjectSpec): void {
  const projectName = projectSpec.name;
  for (const gateway of projectSpec.agentCoreGateways || []) {
    // Imported gateways carry an explicit resourceName that AWS already accepted; skip those.
    if (gateway.resourceName) continue;
    const combinedName = `${projectName}-${gateway.name}`;
    if (combinedName.length > MAX_GATEWAY_NAME_LENGTH) {
      throw new ValidationError(
        `Gateway name too long: "${combinedName}" (${combinedName.length} chars). ` +
          `AWS limits gateway names to ${MAX_GATEWAY_NAME_LENGTH} characters. ` +
          `Shorten the project name or gateway name in agentcore.json.`
      );
    }
  }
}

/**
 * Validates that Container agents have required Dockerfiles.
 */
export function validateContainerAgents(projectSpec: AgentCoreProjectSpec, configRoot: string): void {
  const errors: string[] = [];
  for (const agent of projectSpec.runtimes || []) {
    if (agent.build === 'Container') {
      // Build context + Dockerfile via the shared resolver (identical to how ContainerSourceAsset
      // uploads the context and how the CodeBuild buildspec resolves the -f path).
      const { buildContext, dockerfilePath } = resolveBuildContext(agent, configRoot);

      if (!existsSync(dockerfilePath)) {
        errors.push(
          `Agent "${agent.name}": ${agent.dockerfile ?? DOCKERFILE_NAME} not found at ${dockerfilePath}. Container agents require a Dockerfile.`
        );
      }
      warnDeprecatedBaseImage(dockerfilePath, agent.name);

      // Dockerfile validated. buildContextPath widens the docker build context (e.g. the whole repo);
      // ensure a .dockerignore at that root so secrets/junk (.env, .git, agentcore/) are never baked
      // into the local image. Both local and deploy honor this file; it is created only when absent
      // (never overwrites the user's) and only AFTER validation — so a failing deploy leaves no stray
      // file and this never masks the friendly "Dockerfile not found" error above.
      if (agent.buildContextPath) {
        const created = ensureBuildContextDockerignore(buildContext);
        if (created) {
          console.warn(
            `Agent "${agent.name}": created ${created} with default secret exclusions because buildContextPath is ` +
              `set (the entire context is sent to Docker/CodeBuild). Review and commit it; edit to include any ` +
              `intentionally-bundled files.`
          );
        }
      }
    }
  }
  if (errors.length > 0) {
    throw new Error(errors.join('\n'));
  }
}

/**
 * Validate every per-harness `harness.json` against HarnessSpecSchema so a bad harness spec
 * fails preflight with the precise Zod message (e.g. "sessionStoragePath ... pattern") instead
 * of surfacing only "CDK synth failed: Subprocess exited with error 1" mid-deploy. The vended
 * CDK app re-parses these at synth, so this just moves the same error earlier and makes it readable.
 */
export async function validateHarnessSpecs(projectSpec: AgentCoreProjectSpec, configRoot: string): Promise<void> {
  const harnesses = projectSpec.harnesses ?? [];
  if (harnesses.length === 0) return;

  const configIO = new ConfigIO({ baseDir: configRoot });
  const errors: string[] = [];
  for (const harness of harnesses) {
    try {
      await configIO.readHarnessSpec(harness.name);
    } catch (err) {
      errors.push(`Harness "${harness.name}": ${formatError(err)}`);
    }
  }
  if (errors.length > 0) {
    throw new ValidationError(`Invalid harness configuration:\n${errors.join('\n')}`);
  }
}

const DEPRECATED_BASE_IMAGES: Record<string, string> = {
  'slim-bookworm':
    'Affected by CVE-2026-42010 (GnuTLS authentication bypass). Update the FROM line to use a Trixie-based variant.',
};

function warnDeprecatedBaseImage(dockerfilePath: string, agentName: string): void {
  try {
    const content = readFileSync(dockerfilePath, 'utf-8');
    for (const line of content.split('\n')) {
      if (!/^\s*FROM\s+/i.test(line)) continue;
      for (const [image, message] of Object.entries(DEPRECATED_BASE_IMAGES)) {
        if (line.includes(image)) {
          console.warn(`Warning: Agent "${agentName}" Dockerfile uses a base image containing "${image}". ${message}`);
        }
      }
    }
  } catch {
    // Non-fatal — if we can't read the file, the existing validation will handle it
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
  /** Target region for CDK operations. Without this, toolkit may default to us-east-1. */
  region?: string;
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
    region: options?.region,
  });

  // synth() produces the assembly internally and stores the directory for later use
  let synthResult: { stackNames: string[]; assemblyDirectory: string };
  try {
    synthResult = await toolkitWrapper.synth();
  } catch (err) {
    throw rewriteIfStaleCdkConstruct(err, cdkProject.projectDir);
  }

  return {
    toolkitWrapper,
    stackNames: synthResult.stackNames,
  };
}

// Matches the construct's config validator output: `path: unknown keys (remove): "a", "b"`.
// See @aws/agentcore-cdk src/lib/errors/config.ts (unrecognized_keys formatting).
const UNKNOWN_KEYS_PATTERN = /unknown keys \(remove\): (.+?)(?:\n|$)/;

/**
 * Pull the rejected key names out of an "unknown keys (remove)" message anywhere in the
 * error's cause chain. Returns [] when the error is not an unknown-keys rejection.
 */
export function extractUnknownKeys(err: unknown): string[] {
  const message = formatError(err);
  const match = UNKNOWN_KEYS_PATTERN.exec(message);
  if (!match?.[1]) return [];
  return match[1]
    .split(',')
    .map(k => k.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
}

/**
 * Read the version of @aws/agentcore-cdk actually installed in the vended CDK project.
 * Returns undefined when it can't be determined (the error message degrades gracefully).
 */
export function readInstalledCdkConstructVersion(cdkProjectDir: string): string | undefined {
  try {
    const pkgPath = path.join(cdkProjectDir, 'node_modules', '@aws', 'agentcore-cdk', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string };
    return pkg.version;
  } catch {
    return undefined;
  }
}

/**
 * If a synth failure is an "unknown keys" rejection, it is provably a version skew: the CLI
 * strict-validates agentcore.json against its own schema during preflight (validateProject),
 * *before* synth runs. So any unknown-key the CLI wrote is one the CLI considers valid, and the
 * rejection means the project's bundled @aws/agentcore-cdk is older than the CLI. Rewrite to a
 * StaleCdkConstructError with an actionable hint. Any other error passes through untouched.
 */
export function rewriteIfStaleCdkConstruct(err: unknown, cdkProjectDir: string): unknown {
  const rejectedKeys = extractUnknownKeys(err);
  if (rejectedKeys.length === 0) return err instanceof Error ? err : new Error(String(err));
  const installedVersion = readInstalledCdkConstructVersion(cdkProjectDir);
  return new StaleCdkConstructError(rejectedKeys, installedVersion, { cause: err });
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
    if (!bootstrapStatus.isBootstrapped || (bootstrapStatus.bootstrapVersion ?? 0) < MINIMUM_CDK_BOOTSTRAP_VERSION) {
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
