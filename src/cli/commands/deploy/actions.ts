import {
  ConfigIO,
  DependencySyncError,
  ResourceNotFoundError,
  SecureCredentials,
  ValidationError,
  toError,
} from '../../../lib';
import type { DependencySyncResult } from '../../../lib/dependency-management';
import type { Result } from '../../../lib/result';
import type { AgentCoreMcpSpec, DeployedState } from '../../../schema';
import { applyTargetRegionToEnv } from '../../aws';
import { validateAwsCredentials } from '../../aws/account';
import { CdkToolkitWrapper, createSwitchableIoHost } from '../../cdk/toolkit-lib';
import type { DeployMessage, SwitchableIoHost } from '../../cdk/toolkit-lib';
import {
  buildDeployedState,
  getStackOutputs,
  parseAgentOutputs,
  parseCapacityProviderOutputs,
  parseConfigBundleOutputs,
  parseDatasetOutputs,
  parseEvaluatorOutputs,
  parseGatewayOutputs,
  parseHarnessOutputs,
  parseKnowledgeBaseOutputs,
  parseMemoryOutputs,
  parseOnlineEvalOutputs,
  parsePaymentOutputs,
  parsePolicyEngineOutputs,
  parsePolicyOutputs,
  parseRuntimeEndpointOutputs,
} from '../../cloudformation';
import { getErrorMessage } from '../../errors';
import { ExecLogger } from '../../logging';
import {
  MANAGED_MEMORY_DEPLOY_NOTICE,
  SYNC_CDK_DEPENDENCIES_STEP,
  assertEnvFileExists,
  backfillContainerVpcIds,
  bootstrapEnvironment,
  buildCdkProject,
  checkBootstrapNeeded,
  checkStackDeployability,
  ensureDefaultDeploymentTarget,
  ensureManagedDependencies,
  failedSyncResult,
  getAllCredentials,
  hasIdentityApiProviders,
  hasIdentityOAuthProviders,
  hasManagedMemoryHarness,
  performStackTeardown,
  setupApiKeyProviders,
  setupOAuth2Providers,
  setupTransactionSearch,
  synthesizeCdk,
  teardownSyncFailureResult,
  validateProject,
} from '../../operations/deploy';
import { computeProjectDeployHash } from '../../operations/deploy/change-detection';
import { formatTargetStatus, getGatewayTargetStatuses } from '../../operations/deploy/gateway-status';
import { syncDatasets } from '../../operations/deploy/post-deploy-datasets';
import { autoIngestKnowledgeBases } from '../../operations/deploy/post-deploy-knowledge-bases';
import { enableOnlineEvalConfigs } from '../../operations/deploy/post-deploy-online-evals';
import {
  cleanupPaymentCredentialProviders,
  hasPaymentCredentialProviders,
  setupPaymentCredentialProviders,
} from '../../operations/deploy/pre-deploy-identity';
import { findOrphanHarnesses } from '../../operations/harness/orphan';
import { hydrateKnowledgeBaseDataSources } from '../../operations/knowledge-base/hydrate-data-sources';
import { toStackName } from '../import/import-utils';
import type { DeployResult } from './types';
import { StackSelectionStrategy } from '@aws-cdk/toolkit-lib';
import { resolve } from 'node:path';

export interface ValidatedDeployOptions {
  target: string;
  autoConfirm?: boolean;
  verbose?: boolean;
  plan?: boolean;
  diff?: boolean;
  onProgress?: (step: string, status: 'start' | 'success' | 'error' | 'warn') => void;
  onResourceEvent?: (message: string) => void;
  onDeployMessage?: (message: DeployMessage) => void;
  /** Emit a one-shot, user-facing notice to the terminal mid-deploy (e.g. the managed-memory heads-up
   *  shown before the slow CFN apply). Always surfaced, independent of `verbose`. */
  onNotice?: (message: string) => void;
}

const AGENT_NEXT_STEPS = ['agentcore invoke', 'agentcore status'];
const MEMORY_ONLY_NEXT_STEPS = ['agentcore add agent', 'agentcore status'];

/**
 * Compute per-harness config-version drift between the previous deployed-state and the freshly-parsed
 * harness outputs. Only harnesses that emit a version are considered; a changed (or first-seen) version
 * yields a note. Pure + exported for unit testing.
 */
export function computeHarnessVersionDrift(
  prev: Record<string, { harnessVersion?: number }> | undefined,
  next: Record<string, { harnessVersion?: number }>
): { name: string; from?: number; to: number }[] {
  const notes: { name: string; from?: number; to: number }[] = [];
  for (const [name, rec] of Object.entries(next)) {
    if (rec.harnessVersion === undefined) continue;
    const from = prev?.[name]?.harnessVersion;
    if (from !== rec.harnessVersion) notes.push({ name, from, to: rec.harnessVersion });
  }
  return notes;
}

/**
 * Pick the synthesized stack for the target being deployed.
 *
 * The vended CDK app synthesizes one stack per target in aws-targets.json, so a multi-target
 * project's assembly contains every target's stack. Selecting `stackNames[0]` would describe/persist
 * the *first* target's stack rather than the deployed one — for `deploy --target qa` that meant the
 * Persist step ran `DescribeStacks` on a different (often undeployed) stack and failed. Matching on the
 * deterministic `toStackName(project, target)` keeps the choice correct regardless of target ordering.
 */
export function selectTargetStack(
  stackNames: string[],
  projectName: string,
  targetName: string
): Result<{ stackName: string }, ValidationError> {
  if (stackNames.length === 0) {
    return { success: false, error: new ValidationError('No stacks found to deploy') };
  }
  const expected = toStackName(projectName, targetName);
  if (!stackNames.includes(expected)) {
    return {
      success: false,
      error: new ValidationError(
        `Synthesized stacks [${stackNames.join(', ')}] do not include the stack for target ` +
          `"${targetName}" (expected "${expected}").`
      ),
    };
  }
  return { success: true, stackName: expected };
}

export async function runDiff(
  toolkitWrapper: CdkToolkitWrapper,
  stackName: string,
  switchableIoHost?: SwitchableIoHost
): Promise<void> {
  const diffIoHost = switchableIoHost ?? createSwitchableIoHost();
  let hasDiffContent = false;
  diffIoHost.setOnRawMessage((code, _level, message) => {
    if (!message) return;
    // I4002: formatted diff per stack, I4001: overall diff summary
    if (code === 'CDK_TOOLKIT_I4002' || code === 'CDK_TOOLKIT_I4001') {
      hasDiffContent = true;
      console.log(message);
    }
  });
  diffIoHost.setVerbose(true);
  await toolkitWrapper.diff({
    stacks: { strategy: StackSelectionStrategy.PATTERN_MUST_MATCH, patterns: [stackName] },
  });
  if (!hasDiffContent) {
    console.log('No stack differences detected.');
  }
  diffIoHost.setVerbose(false);
  diffIoHost.setOnRawMessage(null);
}

export async function runDeploy(toolkitWrapper: CdkToolkitWrapper, stackName: string): Promise<void> {
  await toolkitWrapper.deploy({
    stacks: { strategy: StackSelectionStrategy.PATTERN_MUST_MATCH, patterns: [stackName] },
  });
}

export async function handleDeploy(options: ValidatedDeployOptions): Promise<DeployResult> {
  let toolkitWrapper = null;
  let restoreEnv: (() => void) | null = null;
  // In preview modes (--dry-run / --diff) the vpcId backfill writes to agentcore.json/harness.json so
  // the synth subprocess can read it; this reverts those writes on EVERY exit path (success, early
  // return, or throw) so a preview never leaves the working tree dirty. No-op on a real deploy.
  let previewRestore: (() => Promise<void>) | null = null;
  const logger = new ExecLogger({ command: 'deploy' });
  const { onProgress } = options;
  let currentStepName = '';
  // Hoisted above the try so every failure result — the catch AND the explicit failure
  // returns after the sync step — still carries the sync outcome: dep_sync_* telemetry and
  // the user-facing rewrite notice must survive a deploy that fails after the sync ran.
  let dependencySyncResult: DependencySyncResult | undefined;

  const startStep = (name: string) => {
    currentStepName = name;
    logger.startStep(name);
    onProgress?.(name, 'start');
  };

  const endStep = (status: 'success' | 'error' | 'warn', message?: string) => {
    logger.endStep(status, message);
    onProgress?.(currentStepName, status);
  };

  /**
   * Build the failure result every failed deploy must return: finalize the log, then attach
   * `logPath` and the CURRENT `dependencySyncResult` (read from closure at call time — dep_sync_*
   * telemetry must survive deploy failures). Centralizing the ritual makes it impossible for a
   * failure site to forget one of these fields. Per-step `endStep('error', ...)` calls and any
   * extra logging stay at the call sites, where the messages differ.
   */
  const fail = (error: Error): Extract<DeployResult, { success: false }> => {
    logger.finalize(false);
    return {
      success: false,
      error,
      logPath: logger.getRelativeLogPath(),
      dependencySyncResult,
    };
  };

  try {
    const configIO = new ConfigIO();

    // Load targets and find the specified one.
    // Freshly-created projects have an empty aws-targets.json (populated at deploy
    // time). The interactive flow prompts for the target; for non-interactive
    // deploys (`--yes`/`--json`/`--target`) auto-populate a default from the
    // detected AWS context so deploy doesn't fail with "target not found".
    startStep('Load deployment target');
    await ensureDefaultDeploymentTarget(configIO);
    const targets = await configIO.resolveAWSDeploymentTargets();
    const target = targets.find(t => t.name === options.target);
    if (!target) {
      endStep('error', `Target "${options.target}" not found`);
      return fail(new ResourceNotFoundError(`Target "${options.target}" not found in aws-targets.json`));
    }
    // Make the resolved target region authoritative for downstream SDK / CDK
    // calls that don't receive an explicit region option.
    // See https://github.com/aws/agentcore-cli/issues/924.
    restoreEnv = applyTargetRegionToEnv(target.region);
    endStep('success');

    // Read project spec for gateway information (used later for deploy step name and outputs)
    let mcpSpec: Pick<AgentCoreMcpSpec, 'agentCoreGateways'> | null = null;
    try {
      const projectSpec = await configIO.readProjectSpec();
      mcpSpec = { agentCoreGateways: projectSpec.agentCoreGateways };
    } catch {
      // Project read failed — no gateways
    }

    // Preflight: validate project
    startStep('Validate project');
    const context = await validateProject(target);
    endStep('success');

    // Warn about imperative-build orphan harnesses (preview→GA transition). These aren't
    // managed by CloudFormation, so this deploy can't delete or adopt them; a same-named CFN
    // harness would 409/rollback. Non-blocking — point the user at `remove harness`. Collected
    // into postDeployWarnings at the success return so they reach the terminal, not just the log.
    // Skipped on a teardown deploy: the "migrate it to GA with --keep" guidance is wrong when the
    // user is tearing everything down, and teardown.ts emits the apt "--discard" warning instead.
    const orphanWarnings: string[] = [];
    if (!context.isTeardownDeploy) {
      const preDeployState = await configIO.readDeployedState().catch(() => undefined);
      for (const orphan of findOrphanHarnesses(preDeployState)) {
        const warning =
          `Harness "${orphan.name}" was created by the preview build and is not managed by ` +
          `CloudFormation. This deploy won't touch it, and it keeps incurring cost. To migrate it ` +
          `to GA, run \`agentcore remove harness ${orphan.name} --keep\` (deletes the old resource ` +
          `but keeps it in agentcore.json), then deploy again so it's recreated under CloudFormation. ` +
          `Use --discard instead if you no longer want it.`;
        logger.log(warning, 'warn');
        orphanWarnings.push(warning);
      }
    }

    // Teardown confirmation: if this is a teardown deploy, require --yes
    if (context.isTeardownDeploy && !options.autoConfirm) {
      return fail(
        new ValidationError(
          'This will delete all deployed resources and the CloudFormation stack. Run with --yes to confirm teardown.'
        )
      );
    }

    // Validate AWS credentials (deferred for teardown deploys until after confirmation)
    if (context.isTeardownDeploy) {
      startStep('Validate AWS credentials');
      await validateAwsCredentials(target);
      endStep('success');
    }

    // Sync managed dependencies: pin agentcore/cdk/package.json to the versions this
    // CLI was tested with, migrating pre-pinning (caret) projects. Must run before the build so
    // the compile sees the reinstalled tree. Throws CliVersionTooOldError on newer-than-CLI skew.
    // Preview modes (--dry-run / --diff) run check-only — they must never mutate the working
    // tree — and teardown deploys downgrade every sync failure to a warning: skew via
    // treatSkewAsWarning, and write/install failures (DependencySyncError, e.g. a broken npm
    // env or a registry outage) via the catch below. Nothing about pinning may block
    // destroying a cost-incurring stack — if node_modules is genuinely unusable, the build
    // step fails on its own.
    const isPreview = !!options.plan || !!options.diff;
    startStep(SYNC_CDK_DEPENDENCIES_STEP);
    try {
      dependencySyncResult = await ensureManagedDependencies(context.cdkProject, {
        checkOnly: isPreview,
        treatSkewAsWarning: context.isTeardownDeploy,
      });
    } catch (syncErr) {
      if (!(context.isTeardownDeploy && syncErr instanceof DependencySyncError)) {
        // The sync itself is the failure: attach a minimal 'failed' result before rethrowing
        // so the outer catch's failure result still carries dep_sync_* telemetry.
        dependencySyncResult = failedSyncResult();
        throw syncErr;
      }
      // The warning-only result flows through the normal dependencySyncResult.warnings channel below.
      dependencySyncResult = teardownSyncFailureResult(syncErr);
    }
    for (const warning of dependencySyncResult.warnings) {
      logger.log(warning, 'warn');
    }
    if (dependencySyncResult.notice) {
      logger.log(dependencySyncResult.notice);
      options.onNotice?.(dependencySyncResult.notice);
    }
    // A suppressed teardown sync failure ends the step as a warning, not a bare success
    // checkmark — mirroring the TUI preflight, which marks the step 'warn'. No message:
    // the warnings loop above already wrote the warning line to the log.
    if (dependencySyncResult.outcome === 'failure-suppressed') {
      endStep('warn');
    } else {
      endStep('success');
    }

    // Build CDK project
    startStep('Build CDK project');
    await buildCdkProject(context.cdkProject);
    endStep('success');

    // Set up identity providers before CDK synth (CDK needs credential ARNs)
    let identityKmsKeyArn: string | undefined;

    // Unified .env.local existence check across ApiKey, OAuth2, and Payment credentials.
    // Lists every required env var upfront so the user can populate the file in one shot.
    const envFileAssertionResult = assertEnvFileExists(context.projectSpec, configIO.getConfigRoot());
    if (!envFileAssertionResult.success) {
      return fail(envFileAssertionResult.error);
    }

    // Read runtime credentials from process.env (enables non-interactive deploy with -y)
    const neededCredentials = getAllCredentials(context.projectSpec);
    const envCredentials: Record<string, string> = {};
    for (const cred of neededCredentials) {
      const value = process.env[cred.envVarName];
      if (value) {
        envCredentials[cred.envVarName] = value;
      }
    }
    const runtimeCredentials =
      Object.keys(envCredentials).length > 0 ? new SecureCredentials(envCredentials) : undefined;

    // Unified credentials map for deployed state (both API Key and OAuth)
    const deployedCredentials: Record<
      string,
      { credentialProviderArn: string; clientSecretArn?: string; callbackUrl?: string }
    > = {};

    if (hasIdentityApiProviders(context.projectSpec)) {
      startStep('Creating credentials...');

      const identityResult = await setupApiKeyProviders({
        projectSpec: context.projectSpec,
        configBaseDir: configIO.getConfigRoot(),
        region: target.region,
        runtimeCredentials,
        enableKmsEncryption: true,
      });
      if (identityResult.hasErrors) {
        const errorResult = identityResult.results.find(r => r.status === 'error' && r.error);
        const errorMsg = errorResult?.error?.message ?? 'Identity setup failed';
        endStep('error', errorMsg);
        return fail(errorResult?.error ?? new Error('unknown error occurred when setting up api key providers'));
      }
      identityKmsKeyArn = identityResult.kmsKeyArn;

      // Collect API Key credential ARNs for deployed state
      for (const result of identityResult.results) {
        if (result.credentialProviderArn) {
          deployedCredentials[result.providerName] = {
            credentialProviderArn: result.credentialProviderArn,
          };
        }
      }
      endStep('success');
    }

    // Set up OAuth credential providers if needed
    if (hasIdentityOAuthProviders(context.projectSpec)) {
      startStep('Creating OAuth credentials...');

      const oauthResult = await setupOAuth2Providers({
        projectSpec: context.projectSpec,
        configBaseDir: configIO.getConfigRoot(),
        region: target.region,
        runtimeCredentials,
      });
      if (oauthResult.hasErrors) {
        // Log detailed error internally, return sanitized message to avoid leaking OAuth details
        const errorResult = oauthResult.results.find(r => r.status === 'error' && r.error);
        logger.log(`OAuth setup error: ${errorResult?.error ?? 'unknown'}`, 'error');
        const errorMsg = 'OAuth credential setup failed. Check the log for details.';
        endStep('error', errorMsg);
        return fail(errorResult?.error ?? new Error(`an unexpected error ocurred when setting up oauth providers`));
      }

      // Collect OAuth credential ARNs for deployed state
      for (const result of oauthResult.results) {
        if (result.credentialProviderArn) {
          deployedCredentials[result.providerName] = {
            credentialProviderArn: result.credentialProviderArn,
            clientSecretArn: result.clientSecretArn,
            callbackUrl: result.callbackUrl,
          };
        }
      }
      endStep('success');
    }

    // Set up payment credential providers before CDK synth (secrets stay imperative)
    // PaymentManager, PaymentConnector, and IAM roles are created by CDK constructs
    if (hasPaymentCredentialProviders(context.projectSpec)) {
      startStep('Setting up payment credentials...');

      const paymentPreDeployResult = await setupPaymentCredentialProviders({
        projectSpec: context.projectSpec,
        configBaseDir: configIO.getConfigRoot(),
        region: target.region,
        runtimeCredentials,
      });

      if (paymentPreDeployResult.hasErrors) {
        const errorMsgs = paymentPreDeployResult.errors.map(e => e.message).join('; ');
        endStep('error', errorMsgs);
        logger.log(`Payment credential setup errors: ${errorMsgs}`, 'error');
        return fail(paymentPreDeployResult.errors[0] ?? new Error('payment deploy preflight steps failed'));
      }

      // Merge payment credential provider ARNs into deployedCredentials (same as identity credentials)
      for (const [name, result] of Object.entries(paymentPreDeployResult.credentialProviders)) {
        deployedCredentials[name] = {
          credentialProviderArn: result.credentialProviderArn,
        };
      }

      endStep('success');
    }

    // Write credential ARNs to deployed state before CDK synth so the template can read them
    if (Object.keys(deployedCredentials).length > 0) {
      const existingPreSynthState = await configIO.readDeployedState().catch(() => ({ targets: {} }) as DeployedState);
      const targetState = existingPreSynthState.targets?.[target.name] ?? { resources: {} };
      targetState.resources ??= {};
      targetState.resources.credentials = deployedCredentials;
      if (identityKmsKeyArn) targetState.resources.identityKmsKeyArn = identityKmsKeyArn;
      await configIO.writeDeployedState({
        ...existingPreSynthState,
        targets: { ...existingPreSynthState.targets, [target.name]: targetState },
      });
    }

    // Backfill vpcId for pre-existing Container+VPC configs written before vpcId was required. This
    // resolves the VPC from the subnets (ec2:DescribeSubnets) and writes it to disk so the CDK synth
    // process — which re-reads agentcore.json / harness.json — has the value it needs. Fresh creates
    // already carry a vpcId, so this is a no-op for them. In preview modes (--dry-run / --diff) the
    // write is reverted after synth via backfill.restore() so a preview leaves the working tree clean.
    const backfill = await backfillContainerVpcIds(configIO, context.projectSpec, target.region, !isPreview);
    // In preview mode, revert the on-disk backfill in `finally` so every exit path (including a synth
    // throw or an early return) leaves the working tree clean. restore() is a no-op on a real deploy.
    if (isPreview) previewRestore = backfill.restore;
    if (backfill.backfilled.length > 0) {
      logger.log(`Resolved networkConfig.vpcId for Container+VPC build(s): ${backfill.backfilled.join(', ')}`, 'info');
    }

    // Synthesize CloudFormation templates
    startStep('Synthesize CloudFormation');
    const switchableIoHost = options.verbose || options.onDeployMessage ? createSwitchableIoHost() : undefined;
    const synthResult = await synthesizeCdk(context.cdkProject, {
      ...(switchableIoHost && { ioHost: switchableIoHost.ioHost }),
      region: target.region,
    });
    toolkitWrapper = synthResult.toolkitWrapper;
    // The assembly holds one stack per target in aws-targets.json. Select the deployed target's
    // stack so every downstream step (deployability check, deploy, Persist/describe) acts on it
    // rather than blindly on stackNames[0] — see selectTargetStack.
    const stackSelection = selectTargetStack(synthResult.stackNames, context.projectSpec.name, target.name);
    if (!stackSelection.success) {
      endStep('error', stackSelection.error.message);
      return fail(stackSelection.error);
    }
    const stackName = stackSelection.stackName;
    endStep('success');

    // Check if bootstrap needed
    startStep('Check bootstrap status');
    const bootstrapCheck = await checkBootstrapNeeded(context.awsTargets);
    if (bootstrapCheck.needsBootstrap) {
      if (options.autoConfirm) {
        logger.log('Bootstrap needed, auto-confirming...');
        await bootstrapEnvironment(toolkitWrapper, target);
      } else {
        endStep('error', 'Bootstrap required');
        return fail(new ValidationError('AWS environment needs bootstrapping. Run with --yes to auto-bootstrap.'));
      }
    }
    endStep('success');

    // Check stack deployability — scope to the deployed target's stack only, not every
    // synthesized target, so a sibling target's in-progress/failed stack can't block this deploy.
    startStep('Check stack status');
    const deployabilityCheck = await checkStackDeployability(target.region, [stackName]);
    if (!deployabilityCheck.canDeploy) {
      endStep('error', deployabilityCheck.message);
      return fail(new Error(deployabilityCheck.message ?? 'Stack is not in a deployable state'));
    }
    endStep('success');

    // Plan mode: stop after synth and checks, don't deploy. The backfilled vpcId written to disk for
    // synth is reverted in the `finally` (covers this and every other preview exit path).
    if (options.plan) {
      logger.finalize(true);
      await toolkitWrapper.dispose();
      toolkitWrapper = null;
      return {
        success: true,
        targetName: target.name,
        stackName,
        logPath: logger.getRelativeLogPath(),
        dependencySyncResult,
      };
    }

    // Diff mode: run cdk diff and exit without deploying. Like plan mode, the backfilled vpcId is
    // reverted in the `finally`, so even a throw in runDiff leaves the working tree clean.
    if (options.diff) {
      startStep('Run CDK diff');
      await runDiff(toolkitWrapper, stackName, switchableIoHost);
      endStep('success');

      logger.finalize(true);
      await toolkitWrapper.dispose();
      toolkitWrapper = null;
      return {
        success: true,
        targetName: target.name,
        stackName,
        logPath: logger.getRelativeLogPath(),
        dependencySyncResult,
      };
    }

    // Managed-memory heads-up (gated): a harness with managed memory provisions a dedicated
    // AgentCore Memory resource during this deploy, which is the slow part. Surface it before the
    // CFN apply so the wait is explained while it happens. The memory mode lives in each harness's
    // harness.json (not the agentcore.json pointer list), so read the specs to detect it.
    if (!context.isTeardownDeploy && (await hasManagedMemoryHarness(configIO, context.projectSpec.harnesses))) {
      logger.log(MANAGED_MEMORY_DEPLOY_NOTICE);
      // Surface to the terminal too (logger.log only writes to the deploy log file). onNotice is wired
      // by the CLI command so the heads-up prints WHILE the slow CFN apply runs, not just in the log.
      // (The TUI deploy flow runs its own orchestrator and emits this notice itself.)
      options.onNotice?.(MANAGED_MEMORY_DEPLOY_NOTICE);
    }

    // Deploy
    const hasGateways = (mcpSpec?.agentCoreGateways?.length ?? 0) > 0;
    const deployStepName = hasGateways ? 'Deploying gateways...' : 'Deploy to AWS';
    startStep(deployStepName);

    // Enable verbose output for resource-level events
    if (switchableIoHost && (options.onResourceEvent || options.onDeployMessage)) {
      switchableIoHost.setOnMessage(msg => {
        options.onResourceEvent?.(msg.message);
        options.onDeployMessage?.(msg);
      });
      switchableIoHost.setVerbose(true);
    }

    await runDeploy(toolkitWrapper, stackName);

    // Disable verbose output
    if (switchableIoHost) {
      switchableIoHost.setVerbose(false);
      switchableIoHost.setOnMessage(null);
    }

    endStep('success');

    if (context.isTeardownDeploy) {
      // Clean up imperative payment credential providers (CFN stack delete handles manager/connector/roles).
      // Harnesses are part of the CloudFormation stack, so stack destroy handles them.
      const existingDeployedState = await configIO.readDeployedState().catch(() => undefined);
      const existingPayments = existingDeployedState?.targets?.[target.name]?.resources?.payments;
      if (existingPayments && Object.keys(existingPayments).length > 0) {
        startStep('Clean up payment credentials');
        try {
          await cleanupPaymentCredentialProviders({ region: target.region, payments: existingPayments });
          endStep('success');
        } catch (cleanupErr) {
          endStep('error', `Payment cleanup: ${getErrorMessage(cleanupErr)}`);
          // Continue with teardown -- payment cleanup is best-effort
        }
      }

      // After deploying the empty spec, destroy the stack entirely
      startStep('Tear down stack');
      const teardown = await performStackTeardown(target.name);
      if (!teardown.success) {
        endStep('error', teardown.error.message);
        return fail(teardown.error);
      }
      endStep('success');

      logger.finalize(true);

      return {
        success: true,
        targetName: target.name,
        stackName,
        logPath: logger.getRelativeLogPath(),
        dependencySyncResult,
      };
    }

    // Get stack outputs and persist state
    startStep('Persist deployment state');
    const outputs = await getStackOutputs(target.region, stackName);
    const agentNames = context.projectSpec.runtimes?.map(a => a.name) || [];
    const agents = parseAgentOutputs(outputs, agentNames, stackName);

    // Parse memory outputs
    const memoryNames = (context.projectSpec.memories ?? []).map(m => m.name);
    const memories = parseMemoryOutputs(outputs, memoryNames);

    if (memoryNames.length > 0 && Object.keys(memories).length !== memoryNames.length) {
      logger.log(
        `Deployed-state missing outputs for ${memoryNames.length - Object.keys(memories).length} memory(ies).`,
        'warn'
      );
    }

    // Parse evaluator outputs
    const evaluatorNames = (context.projectSpec.evaluators ?? []).map(e => e.name);
    const evaluators = parseEvaluatorOutputs(outputs, evaluatorNames);

    // Parse online eval config outputs
    const onlineEvalSpecs = (context.projectSpec.onlineEvalConfigs ?? []).map(c => ({
      name: c.name,
      agent: c.agent,
      endpoint: c.endpoint,
    }));
    const onlineEvalConfigs = parseOnlineEvalOutputs(outputs, onlineEvalSpecs);

    // Parse policy engine outputs
    const policyEngineSpecs = context.projectSpec.policyEngines ?? [];
    const policyEngineNames = policyEngineSpecs.map(pe => pe.name);
    const policyEngines = parsePolicyEngineOutputs(outputs, policyEngineNames);

    // Parse policy outputs
    const policySpecs = policyEngineSpecs.flatMap(pe =>
      pe.policies.map(p => ({ engineName: pe.name, policyName: p.name }))
    );
    const policies = parsePolicyOutputs(outputs, policySpecs);

    // Parse runtime endpoint outputs
    const endpointSpecs: { agentName: string; endpointName: string }[] = [];
    for (const runtime of context.projectSpec.runtimes) {
      if (runtime.endpoints) {
        for (const endpointName of Object.keys(runtime.endpoints)) {
          endpointSpecs.push({ agentName: runtime.name, endpointName });
        }
      }
    }
    const runtimeEndpoints = parseRuntimeEndpointOutputs(outputs, endpointSpecs);

    // Parse gateway outputs
    const allGatewaySpecs = mcpSpec?.agentCoreGateways ?? [];
    const gatewaySpecs = allGatewaySpecs.reduce(
      (acc, gateway) => {
        acc[gateway.name] = gateway;
        return acc;
      },
      {} as Record<string, unknown>
    );
    const allGateways = parseGatewayOutputs(outputs, gatewaySpecs);

    // Split into MCP and HTTP gateways based on protocolType
    const httpGatewayNames = new Set(allGatewaySpecs.filter(g => g.protocolType === 'None').map(g => g.name));
    const gateways: Record<string, { gatewayId: string; gatewayArn: string; gatewayUrl?: string }> = {};
    const httpGateways: Record<
      string,
      { gatewayId: string; gatewayArn: string; gatewayUrl?: string; targets?: Record<string, { targetId: string }> }
    > = {};
    for (const [name, state] of Object.entries(allGateways)) {
      if (httpGatewayNames.has(name)) {
        httpGateways[name] = state;
      } else {
        gateways[name] = state;
      }
    }

    // Parse dataset outputs
    const datasetNames = (context.projectSpec.datasets ?? []).map(d => d.name);
    const datasets = parseDatasetOutputs(outputs, datasetNames);

    // Parse capacity provider outputs
    const capacityProviderNames = (context.projectSpec.capacityProviders ?? []).map(cp => cp.name);
    const capacityProviders = parseCapacityProviderOutputs(outputs, capacityProviderNames);

    // Parse config bundle outputs
    const configBundleNames = (context.projectSpec.configBundles ?? []).map(b => b.name);
    const configBundles = parseConfigBundleOutputs(outputs, configBundleNames);

    // Parse knowledge base outputs (CFN emits id+arn; DSes hydrated next via SDK).
    const knowledgeBaseSpecs = context.projectSpec.knowledgeBases ?? [];
    const knowledgeBaseNames = knowledgeBaseSpecs.map(kb => kb.name);
    const knowledgeBases = parseKnowledgeBaseOutputs(outputs, knowledgeBaseNames);

    if (knowledgeBaseNames.length > 0 && Object.keys(knowledgeBases).length !== knowledgeBaseNames.length) {
      logger.log(
        `Deployed-state missing outputs for ${
          knowledgeBaseNames.length - Object.keys(knowledgeBases).length
        } knowledge base(s).`,
        'warn'
      );
    }

    // Hydrate dataSources[] for each KB by listing DSes via bedrock-agent
    // (the L3 doesn't emit per-DS CFN outputs).
    if (Object.keys(knowledgeBases).length > 0) {
      try {
        await hydrateKnowledgeBaseDataSources({
          knowledgeBases,
          knowledgeBaseSpecs,
          region: target.region,
        });
      } catch (err) {
        logger.log(`Failed to hydrate knowledge base data sources: ${getErrorMessage(err)}`, 'warn');
      }
    }

    // Parse payment outputs from CFN stack
    const paymentSpecs = (context.projectSpec.payments ?? []).map(p => ({
      name: p.name,
      authorizerType: p.authorizerType,
      autoPayment: p.autoPayment,
      paymentToolAllowlist: p.paymentToolAllowlist,
      networkPreferences: p.networkPreferences,
      connectors: p.connectors.map(c => ({
        name: c.name,
        credentialProviderArn: deployedCredentials[c.credentialName]?.credentialProviderArn ?? '',
        credentialProviderName: c.credentialName,
      })),
    }));
    const payments = paymentSpecs.length > 0 ? parsePaymentOutputs(outputs, paymentSpecs) : undefined;

    // Parse harness outputs (harnesses are now part of the CloudFormation stack).
    const harnessNames = (context.projectSpec.harnesses ?? []).map(h => h.name);
    const deployedHarnesses = parseHarnessOutputs(outputs, harnessNames);

    endStep('success');

    let deployHash: string | undefined;
    try {
      deployHash = await computeProjectDeployHash(configIO);
    } catch {
      // hash computation is best-effort
    }

    const existingState = await configIO.readDeployedState().catch(() => undefined);
    // Capture prior harness version records BEFORE the new state overwrites them, for the drift note.
    const prevHarnessRecords = existingState?.targets?.[target.name]?.resources?.harnesses;
    let deployedState = buildDeployedState({
      targetName: target.name,
      stackName,
      agents,
      gateways,
      httpGateways: Object.keys(httpGateways).length > 0 ? httpGateways : undefined,
      existingState,
      identityKmsKeyArn,
      credentials: deployedCredentials,
      memories,
      evaluators,
      onlineEvalConfigs,
      policyEngines,
      policies,
      harnesses: deployedHarnesses,
      runtimeEndpoints,
      datasets,
      configBundles,
      knowledgeBases,
      payments,
      capacityProviders,
      abTestNames: (context.projectSpec.abTests ?? []).map(t => t.name),
    });

    if (deployHash) {
      const targetState = deployedState.targets[target.name];
      if (targetState?.resources) {
        targetState.resources.deployHash = deployHash;
      }
    }

    // CFN succeeded by this point — failing to persist deployed-state.json
    // would leave AWS resources without a local pointer for teardown. Surface
    // a recovery message that names the stack + region so the user can
    // either teardown manually or re-run `agentcore status` once the local
    // I/O issue is resolved.
    try {
      await configIO.writeDeployedState(deployedState);
    } catch (writeErr) {
      const msg = writeErr instanceof Error ? writeErr.message : String(writeErr);
      logger.log(
        `WARNING: deploy succeeded but writing agentcore/deployed-state.json failed: ${msg}.\n` +
          `  Stack: ${stackName} (region: ${target.region})\n` +
          `  AWS resources are running but the CLI cannot track them locally.\n` +
          `  Recovery options:\n` +
          `    1) Fix the local I/O problem (disk space / permissions on agentcore/) and run \`agentcore status\` to refresh.\n` +
          `    2) If you want to teardown what was deployed: \`aws cloudformation delete-stack --stack-name ${stackName} --region ${target.region}\``
      );
      throw writeErr;
    }

    // Harness config-version drift note: the service increments Version on every successful
    // update, so surface what changed this deploy.
    for (const drift of computeHarnessVersionDrift(prevHarnessRecords, deployedHarnesses)) {
      logger.log(
        drift.from !== undefined
          ? `Harness ${drift.name}: config updated (v${drift.from} → v${drift.to})`
          : `Harness ${drift.name}: deployed (v${drift.to})`
      );
    }

    // Show gateway URLs and target sync status
    if (Object.keys(gateways).length > 0) {
      const gatewayUrls = Object.entries(gateways)
        .map(([name, gateway]) => `${name}: ${gateway.gatewayArn}`)
        .join(', ');
      logger.log(`Gateway URLs: ${gatewayUrls}`);

      // Query target sync statuses (non-blocking)
      for (const [, gateway] of Object.entries(gateways)) {
        const statuses = await getGatewayTargetStatuses(gateway.gatewayId, target.region);
        for (const targetStatus of statuses) {
          logger.log(`  ${targetStatus.name}: ${formatTargetStatus(targetStatus.status)}`);
        }
      }
    }

    endStep('success');

    const postDeployWarnings: string[] = [];

    // Auto-payment is a money-movement default; surface its posture per manager
    // so an unattended-spend configuration is never silent at deploy time. This
    // is an informational notice, not a failure — it goes through `notes` (exit
    // 0), NOT postDeployWarnings (which signals partial failure and exits 2).
    const autoPaymentNotices: string[] = [];
    for (const manager of context.projectSpec.payments ?? []) {
      if (manager.autoPayment !== false) {
        const limit = manager.defaultSpendLimit ?? '10.00';
        autoPaymentNotices.push(
          `Payment manager "${manager.name}": auto-payment is ENABLED — the agent will settle ` +
            `402 responses automatically up to the per-session spend limit ($${limit}) with no ` +
            `human approval. Set --auto-payment false on the manager to require manual approval.`
        );
      }
    }

    // Post-deploy: Enable online eval configs that have enableOnCreate (CFN deploys them as DISABLED).
    // Only enable configs that are newly deployed — skip configs that already existed before this
    // deploy run, so we don't re-enable configs a customer intentionally disabled.
    const onlineEvalFullSpecs = context.projectSpec.onlineEvalConfigs ?? [];
    const deployedOnlineEvalConfigs = deployedState.targets?.[target.name]?.resources?.onlineEvalConfigs ?? {};
    const previouslyDeployedOnlineEvals = existingState?.targets?.[target.name]?.resources?.onlineEvalConfigs ?? {};
    const newOnlineEvalFullSpecs = onlineEvalFullSpecs.filter(c => !previouslyDeployedOnlineEvals[c.name]);
    if (newOnlineEvalFullSpecs.length > 0 && Object.keys(deployedOnlineEvalConfigs).length > 0) {
      const enableResult = await enableOnlineEvalConfigs({
        region: target.region,
        onlineEvalConfigs: newOnlineEvalFullSpecs,
        deployedOnlineEvalConfigs,
      });

      if (enableResult.hasErrors) {
        const errors = enableResult.results.filter(r => r.status === 'error');
        const errorMessages = errors.map(err => `"${err.configName}": ${err.error}`).join('; ');
        logger.log(`Online eval enable warnings: ${errorMessages}`, 'warn');
        postDeployWarnings.push(...errors.map(err => `Online eval "${err.configName}": ${err.error}`));
      }
    }

    // Post-deploy: Sync dataset examples from local JSONL to service DRAFT.
    // Uses a local content hash to skip unchanged files (hybrid approach).
    const datasetSpecs = context.projectSpec.datasets ?? [];
    const deployedDatasetsRecord = deployedState.targets?.[target.name]?.resources?.datasets ?? {};
    if (datasetSpecs.length > 0 && Object.keys(deployedDatasetsRecord).length > 0) {
      const datasetSyncResult = await syncDatasets({
        region: target.region,
        datasets: datasetSpecs,
        deployedDatasets: deployedDatasetsRecord,
        configBaseDir: configIO.getConfigRoot(),
      });

      // Update deployed state with new content hashes
      if (datasetSyncResult.results.some(r => r.status === 'synced')) {
        const updatedState = await configIO.readDeployedState().catch(() => deployedState);
        const targetResources = updatedState.targets[target.name]?.resources;
        if (targetResources) {
          targetResources.datasets = datasetSyncResult.updatedDatasets;
          await configIO.writeDeployedState(updatedState);
          deployedState = updatedState;
        }
      }

      if (datasetSyncResult.hasErrors) {
        const errors = datasetSyncResult.results.filter(r => r.status === 'error');
        const errorMessages = errors.map(err => `"${err.datasetName}": ${err.error}`).join('; ');
        logger.log(`Dataset sync warnings: ${errorMessages}`, 'warn');
        postDeployWarnings.push(...errors.map(err => `Dataset "${err.datasetName}": ${err.error}`));
      }

      for (const r of datasetSyncResult.results) {
        if (r.status === 'synced') {
          logger.log(`Dataset "${r.datasetName}": +${r.added} added, ~${r.updated} updated, -${r.deleted} deleted`);
        }
      }
    }

    // Post-deploy: auto-trigger ingestion for any KB whose data-source URIs
    // changed since the last deploy (or has never been ingested before).
    const knowledgeBaseSpecsForIngest = context.projectSpec.knowledgeBases ?? [];
    if (knowledgeBaseSpecsForIngest.length > 0) {
      startStep('Auto-ingest knowledge bases');
      const ingestResult = await autoIngestKnowledgeBases({
        region: target.region,
        knowledgeBases: knowledgeBaseSpecsForIngest,
        deployedKnowledgeBases: deployedState.targets?.[target.name]?.resources?.knowledgeBases ?? {},
        previousKnowledgeBases: existingState?.targets?.[target.name]?.resources?.knowledgeBases,
        targetName: target.name,
        deployedState,
        projectRoot: resolve(configIO.getConfigRoot(), '..'),
        onProgress: msg => logger.log(msg),
      });

      // Persist new sourcesHash values for KBs whose ingestion fired.
      const targetResources = deployedState.targets[target.name]?.resources;
      if (targetResources?.knowledgeBases) {
        for (const r of ingestResult.results) {
          if (r.status === 'started' && r.newSourcesHash) {
            const record = targetResources.knowledgeBases[r.knowledgeBaseName];
            if (record) record.sourcesHash = r.newSourcesHash;
          }
        }
        await configIO.writeDeployedState(deployedState);
      }

      // Log per-KB result so the user sees what happened.
      for (const r of ingestResult.results) {
        if (r.status === 'started') {
          logger.log(
            `Knowledge base "${r.knowledgeBaseName}": ingestion started for ${r.startedJobCount} data source(s)`
          );
        } else if (r.status === 'skipped') {
          logger.log(`Knowledge base "${r.knowledgeBaseName}": skipped (${r.reason})`);
        } else {
          logger.log(`Knowledge base "${r.knowledgeBaseName}": ${r.error}`, 'warn');
          postDeployWarnings.push(`Knowledge base "${r.knowledgeBaseName}": ${r.error}`);
        }
      }
      endStep(ingestResult.hasErrors ? 'error' : 'success');
    }

    // Config bundles are now managed via CloudFormation; their state is parsed
    // from stack outputs above (no post-deploy API step). AB tests are managed
    // as fire-and-forget jobs (agentcore run ab-test), not via the deploy path.

    // Post-deploy: Enable CloudWatch Transaction Search (non-blocking, silent)
    const hasHarnesses = (context.projectSpec.harnesses ?? []).length > 0;
    const hasInvokable = agentNames.length > 0 || hasHarnesses;
    const nextSteps = hasInvokable ? [...AGENT_NEXT_STEPS] : [...MEMORY_ONLY_NEXT_STEPS];
    const notes: string[] = [...autoPaymentNotices];
    const hasPythonAgent =
      context.projectSpec.runtimes?.some(a => a.entrypoint?.endsWith('.py') || a.entrypoint?.includes('.py:')) ?? false;
    if ((agentNames.length > 0 || hasGateways) && hasPythonAgent) {
      try {
        const tsResult = await setupTransactionSearch({
          region: target.region,
          accountId: target.account,
          agentNames,
          hasGateways,
        });
        if (!tsResult.success) {
          logger.log(`Transaction search setup warning: ${tsResult.error.message}`, 'warn');
        } else {
          notes.push(
            'Transaction search enabled. It takes ~10 minutes for transaction search to be fully active and for traces from invocations to be indexed.'
          );
        }
      } catch (err: unknown) {
        logger.log(`Transaction search setup failed: ${getErrorMessage(err)}`, 'warn');
      }
    }

    logger.finalize(true);

    // Surface orphan-harness warnings (collected pre-deploy) to the terminal alongside any
    // post-deploy warnings — logger.log only writes to the log file. Dependency-sync warnings
    // are deliberately NOT merged here: postDeployWarnings signals partial failure (exit 2),
    // while dep-sync warnings are informational (e.g. the bundled-tarball override is always
    // "left unmanaged"). They reach the terminal via result.dependencySyncResult.warnings, which the
    // CLI (printDeployResult), dev path (runCliDeploy), and TUI each render.
    const allWarnings = [...orphanWarnings, ...postDeployWarnings];

    return {
      success: true,
      targetName: target.name,
      stackName,
      outputs,
      logPath: logger.getRelativeLogPath(),
      nextSteps,
      notes,
      postDeployWarnings: allWarnings.length > 0 ? allWarnings : undefined,
      dependencySyncResult,
    };
  } catch (err: unknown) {
    logger.log(getErrorMessage(err), 'error');
    // fail() carries the dep-sync outcome on the failure result too, so dep_sync_* telemetry
    // is recorded even when a later step throws.
    return fail(toError(err));
  } finally {
    // Each cleanup step must run regardless of whether an earlier one fails — a throw from
    // dispose() (common after a synth/bootstrap failure on a creds-less preview) must not skip the
    // vpcId-backfill revert or the env restore. Isolate each with try/catch.
    if (toolkitWrapper) {
      try {
        await toolkitWrapper.dispose();
      } catch (disposeErr) {
        logger.log(`CDK toolkit dispose failed: ${getErrorMessage(disposeErr)}`, 'warn');
      }
    }
    // Revert the preview-mode vpcId backfill on every exit path (success, early return, or throw).
    if (previewRestore) {
      try {
        await previewRestore();
      } catch (restoreErr) {
        logger.log(`Failed to revert preview vpcId backfill: ${getErrorMessage(restoreErr)}`, 'warn');
      }
    }
    restoreEnv?.();
  }
}
