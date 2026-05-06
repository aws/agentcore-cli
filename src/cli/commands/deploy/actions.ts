import { ConfigIO, SecureCredentials } from '../../../lib';
import type { AgentCoreMcpSpec, DeployedState } from '../../../schema';
import { applyTargetRegionToEnv } from '../../aws';
import { validateAwsCredentials } from '../../aws/account';
import { CdkToolkitWrapper, createSwitchableIoHost } from '../../cdk/toolkit-lib';
import type { SwitchableIoHost } from '../../cdk/toolkit-lib';
import {
  buildDeployedState,
  getStackOutputs,
  parseAgentOutputs,
  parseEvaluatorOutputs,
  parseGatewayOutputs,
  parseMemoryOutputs,
  parseOnlineEvalOutputs,
  parsePolicyEngineOutputs,
  parsePolicyOutputs,
  parseRuntimeEndpointOutputs,
} from '../../cloudformation';
import { getErrorMessage } from '../../errors';
import { ExecLogger } from '../../logging';
import {
  bootstrapEnvironment,
  buildCdkProject,
  checkBootstrapNeeded,
  checkStackDeployability,
  getAllCredentials,
  hasIdentityApiProviders,
  hasIdentityOAuthProviders,
  performStackTeardown,
  setupApiKeyProviders,
  setupOAuth2Providers,
  setupTransactionSearch,
  synthesizeCdk,
  validateProject,
} from '../../operations/deploy';
import { formatTargetStatus, getGatewayTargetStatuses } from '../../operations/deploy/gateway-status';
import { deleteOrphanedABTests, setupABTests } from '../../operations/deploy/post-deploy-ab-tests';
import {
  resolveConfigBundleComponentKeys,
  setupConfigBundles,
} from '../../operations/deploy/post-deploy-config-bundles';
import { setupHttpGateways } from '../../operations/deploy/post-deploy-http-gateways';
import { enableOnlineEvalConfigs } from '../../operations/deploy/post-deploy-online-evals';
import { toStackName } from '../import/import-utils';
import type { DeployResult } from './types';
import { StackSelectionStrategy } from '@aws-cdk/toolkit-lib';

export interface ValidatedDeployOptions {
  target: string;
  autoConfirm?: boolean;
  verbose?: boolean;
  plan?: boolean;
  diff?: boolean;
  onProgress?: (step: string, status: 'start' | 'success' | 'error') => void;
  onResourceEvent?: (message: string) => void;
}

const AGENT_NEXT_STEPS = ['agentcore invoke', 'agentcore status'];
const MEMORY_ONLY_NEXT_STEPS = ['agentcore add agent', 'agentcore status'];

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
  const logger = new ExecLogger({ command: 'deploy' });
  const { onProgress } = options;
  let currentStepName = '';

  const startStep = (name: string) => {
    currentStepName = name;
    logger.startStep(name);
    onProgress?.(name, 'start');
  };

  const endStep = (status: 'success' | 'error', message?: string) => {
    logger.endStep(status, message);
    onProgress?.(currentStepName, status);
  };

  try {
    const configIO = new ConfigIO();

    // Load targets and find the specified one
    startStep('Load deployment target');
    const targets = await configIO.resolveAWSDeploymentTargets();
    const target = targets.find(t => t.name === options.target);
    if (!target) {
      endStep('error', `Target "${options.target}" not found`);
      logger.finalize(false);
      return {
        success: false,
        error: `Target "${options.target}" not found in aws-targets.json`,
        logPath: logger.getRelativeLogPath(),
      };
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
    const context = await validateProject();
    endStep('success');

    // Teardown confirmation: if this is a teardown deploy, require --yes
    if (context.isTeardownDeploy && !options.autoConfirm) {
      logger.finalize(false);
      return {
        success: false,
        error:
          'This will delete all deployed resources and the CloudFormation stack. Run with --yes to confirm teardown.',
        logPath: logger.getRelativeLogPath(),
      };
    }

    // Validate AWS credentials (deferred for teardown deploys until after confirmation)
    if (context.isTeardownDeploy) {
      startStep('Validate AWS credentials');
      await validateAwsCredentials();
      endStep('success');
    }

    // Build CDK project
    startStep('Build CDK project');
    await buildCdkProject(context.cdkProject);
    endStep('success');

    // Set up identity providers before CDK synth (CDK needs credential ARNs)
    let identityKmsKeyArn: string | undefined;

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
        const errorResult = identityResult.results.find(r => r.status === 'error');
        const errorMsg =
          errorResult?.error && typeof errorResult.error === 'string' ? errorResult.error : 'Identity setup failed';
        endStep('error', errorMsg);
        logger.finalize(false);
        return { success: false, error: errorMsg, logPath: logger.getRelativeLogPath() };
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
        const errorResult = oauthResult.results.find(r => r.status === 'error');
        logger.log(`OAuth setup error: ${errorResult?.error ?? 'unknown'}`, 'error');
        const errorMsg = 'OAuth credential setup failed. Check the log for details.';
        endStep('error', errorMsg);
        logger.finalize(false);
        return { success: false, error: errorMsg, logPath: logger.getRelativeLogPath() };
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

    // Synthesize CloudFormation templates
    startStep('Synthesize CloudFormation');
    const switchableIoHost = options.verbose ? createSwitchableIoHost() : undefined;
    const synthResult = await synthesizeCdk(
      context.cdkProject,
      switchableIoHost ? { ioHost: switchableIoHost.ioHost } : undefined
    );
    toolkitWrapper = synthResult.toolkitWrapper;
    const stackNames = synthResult.stackNames;
    if (stackNames.length === 0) {
      endStep('error', 'No stacks found');
      logger.finalize(false);
      return { success: false, error: 'No stacks found to deploy', logPath: logger.getRelativeLogPath() };
    }
    const stackName = stackNames[0]!;
    endStep('success');

    const targetStackName = toStackName(context.projectSpec.name, target.name);

    // Check if bootstrap needed
    startStep('Check bootstrap status');
    const bootstrapCheck = await checkBootstrapNeeded(context.awsTargets);
    if (bootstrapCheck.needsBootstrap) {
      if (options.autoConfirm) {
        logger.log('Bootstrap needed, auto-confirming...');
        await bootstrapEnvironment(toolkitWrapper, target);
      } else {
        endStep('error', 'Bootstrap required');
        logger.finalize(false);
        return {
          success: false,
          error: 'AWS environment needs bootstrapping. Run with --yes to auto-bootstrap.',
          logPath: logger.getRelativeLogPath(),
        };
      }
    }
    endStep('success');

    // Check stack deployability
    startStep('Check stack status');
    const deployabilityCheck = await checkStackDeployability(target.region, stackNames);
    if (!deployabilityCheck.canDeploy) {
      endStep('error', deployabilityCheck.message);
      logger.finalize(false);
      return {
        success: false,
        error: deployabilityCheck.message ?? 'Stack is not in a deployable state',
        logPath: logger.getRelativeLogPath(),
      };
    }
    endStep('success');

    // Plan mode: stop after synth and checks, don't deploy
    if (options.plan) {
      logger.finalize(true);
      await toolkitWrapper.dispose();
      toolkitWrapper = null;
      return {
        success: true,
        targetName: target.name,
        stackName,
        logPath: logger.getRelativeLogPath(),
      };
    }

    // Diff mode: run cdk diff and exit without deploying
    if (options.diff) {
      startStep('Run CDK diff');
      await runDiff(toolkitWrapper, targetStackName, switchableIoHost);
      endStep('success');

      logger.finalize(true);
      await toolkitWrapper.dispose();
      toolkitWrapper = null;
      return {
        success: true,
        targetName: target.name,
        stackName,
        logPath: logger.getRelativeLogPath(),
      };
    }

    // Deploy
    const hasGateways = (mcpSpec?.agentCoreGateways?.length ?? 0) > 0;
    const deployStepName = hasGateways ? 'Deploying gateways...' : 'Deploy to AWS';
    startStep(deployStepName);

    // Enable verbose output for resource-level events
    if (switchableIoHost && options.onResourceEvent) {
      switchableIoHost.setOnMessage(msg => {
        options.onResourceEvent!(msg.message);
      });
      switchableIoHost.setVerbose(true);
    }

    await runDeploy(toolkitWrapper, targetStackName);

    // Disable verbose output
    if (switchableIoHost) {
      switchableIoHost.setVerbose(false);
      switchableIoHost.setOnMessage(null);
    }

    endStep('success');

    if (context.isTeardownDeploy) {
      // After deploying the empty spec, destroy the stack entirely
      startStep('Tear down stack');
      const teardown = await performStackTeardown(target.name);
      if (!teardown.success) {
        const teardownError = typeof teardown.error === 'string' ? teardown.error : 'Unknown teardown error';
        endStep('error', teardownError);
        logger.finalize(false);
        return {
          success: false,
          error: `Stack teardown failed: ${teardownError}`,
          logPath: logger.getRelativeLogPath(),
        };
      }
      endStep('success');

      logger.finalize(true);

      return {
        success: true,
        targetName: target.name,
        stackName,
        logPath: logger.getRelativeLogPath(),
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
    const gatewaySpecs =
      mcpSpec?.agentCoreGateways?.reduce(
        (acc, gateway) => {
          acc[gateway.name] = gateway;
          return acc;
        },
        {} as Record<string, unknown>
      ) ?? {};
    const gateways = parseGatewayOutputs(outputs, gatewaySpecs);

    const existingState = await configIO.readDeployedState().catch(() => undefined);
    let deployedState = buildDeployedState({
      targetName: target.name,
      stackName,
      agents,
      gateways,
      existingState,
      identityKmsKeyArn,
      credentials: deployedCredentials,
      memories,
      evaluators,
      onlineEvalConfigs,
      policyEngines,
      policies,
      runtimeEndpoints,
    });
    await configIO.writeDeployedState(deployedState);

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

    // Post-deploy: Enable online eval configs that have enableOnCreate (CFN deploys them as DISABLED).
    // Only enable configs that are newly deployed — skip configs that already existed before this
    // deploy run, so we don't re-enable configs a customer intentionally disabled.
    const postDeployWarnings: string[] = [];
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

    // Pre-gateway: Delete orphaned AB tests so their gateway rules are cleaned up
    // before we attempt to delete orphaned HTTP gateways.
    const existingABTestsForCleanup = deployedState.targets?.[target.name]?.resources?.abTests;
    if (existingABTestsForCleanup && Object.keys(existingABTestsForCleanup).length > 0) {
      const deleteResult = await deleteOrphanedABTests({
        region: target.region,
        projectSpec: context.projectSpec,
        existingABTests: existingABTestsForCleanup,
      });

      if (deleteResult.hasErrors) {
        const errors = deleteResult.results.filter(r => r.status === 'error');
        const errorMessages = errors.map(err => `"${err.testName}": ${err.error}`).join('; ');
        logger.log(`AB test orphan cleanup warnings: ${errorMessages}`, 'warn');
        postDeployWarnings.push(...errors.map(err => `AB test "${err.testName}": ${err.error}`));
      }

      // Surface warnings (e.g., "AB test was stopped before deletion")
      for (const r of deleteResult.results) {
        if (r.warning) {
          logger.log(r.warning, 'warn');
          postDeployWarnings.push(r.warning);
        }
      }

      // Update deployed state to remove deleted AB tests
      if (deleteResult.results.some(r => r.status === 'deleted')) {
        const updatedState = await configIO.readDeployedState().catch(() => deployedState);
        const targetResources = updatedState.targets[target.name]?.resources;
        if (targetResources?.abTests) {
          for (const r of deleteResult.results) {
            if (r.status === 'deleted') delete targetResources.abTests[r.testName];
          }
          await configIO.writeDeployedState(updatedState);
          deployedState = updatedState;
        }
      }
    }

    // Post-deploy: Create/update HTTP gateways for AB tests (must run BEFORE config bundles
    // because config bundle component keys may reference gateway ARNs)
    const httpGatewaySpecs = context.projectSpec.httpGateways ?? [];
    const existingHttpGateways = deployedState.targets?.[target.name]?.resources?.httpGateways;
    if (httpGatewaySpecs.length > 0 || Object.keys(existingHttpGateways ?? {}).length > 0) {
      const deployedResources = deployedState.targets?.[target.name]?.resources;
      const httpGatewayResult = await setupHttpGateways({
        region: target.region,
        projectName: context.projectSpec.name,
        projectSpec: context.projectSpec,
        existingHttpGateways,
        deployedResources,
      });

      // Always merge HTTP gateway state (even if empty, to clear deleted gateways)
      const updatedState = await configIO.readDeployedState().catch(() => deployedState);
      const targetResources = updatedState.targets[target.name]?.resources;
      if (targetResources) {
        targetResources.httpGateways = httpGatewayResult.httpGateways;
        await configIO.writeDeployedState(updatedState);
        deployedState = updatedState;
      }

      if (httpGatewayResult.hasErrors) {
        const errors = httpGatewayResult.results.filter(r => r.status === 'error');
        const errorMessages = errors.map(err => `"${err.gatewayName}": ${err.error}`).join('; ');
        logger.log(`HTTP gateway setup warnings: ${errorMessages}`, 'warn');
        postDeployWarnings.push(...errors.map(err => `HTTP gateway "${err.gatewayName}": ${err.error}`));
      }
    }

    // Post-deploy: Create/update configuration bundles
    const configBundleSpecs = context.projectSpec.configBundles ?? [];
    if (configBundleSpecs.length > 0) {
      // Resolve component key placeholders (e.g., {{gateway:name}} → real ARN)
      const resolvedProjectSpec = resolveConfigBundleComponentKeys(context.projectSpec, deployedState, target.name);

      const existingConfigBundles = deployedState.targets?.[target.name]?.resources?.configBundles;
      const configBundleResult = await setupConfigBundles({
        region: target.region,
        projectSpec: resolvedProjectSpec,
        existingBundles: existingConfigBundles,
      });

      // Merge config bundle state into deployed state
      if (Object.keys(configBundleResult.configBundles).length > 0) {
        const updatedState = await configIO.readDeployedState().catch(() => deployedState);
        const targetResources = updatedState.targets[target.name]?.resources;
        if (targetResources) {
          targetResources.configBundles = configBundleResult.configBundles;
          await configIO.writeDeployedState(updatedState);
          deployedState = updatedState;
        }
      }

      if (configBundleResult.hasErrors) {
        const errors = configBundleResult.results.filter(r => r.status === 'error');
        const errorMessages = errors.map(err => `"${err.bundleName}": ${err.error}`).join('; ');
        logger.log(`Config bundle setup warnings: ${errorMessages}`, 'warn');
        postDeployWarnings.push(...errors.map(err => `Config bundle "${err.bundleName}": ${err.error}`));
      }
    }

    // Post-deploy: Create/update AB tests
    const abTestSpecs = context.projectSpec.abTests ?? [];
    if (abTestSpecs.length > 0) {
      const existingABTests = deployedState.targets?.[target.name]?.resources?.abTests;
      const deployedResources = deployedState.targets?.[target.name]?.resources;
      const abTestResult = await setupABTests({
        region: target.region,
        projectSpec: context.projectSpec,
        existingABTests,
        deployedResources,
      });

      // Merge AB test state into deployed state
      if (Object.keys(abTestResult.abTests).length > 0) {
        const updatedState = await configIO.readDeployedState().catch(() => deployedState);
        const targetResources = updatedState.targets[target.name]?.resources;
        if (targetResources) {
          targetResources.abTests = abTestResult.abTests;
          await configIO.writeDeployedState(updatedState);
        }
      }

      if (abTestResult.hasErrors) {
        const errors = abTestResult.results.filter(r => r.status === 'error');
        const errorMessages = errors.map(err => `"${err.testName}": ${err.error}`).join('; ');
        logger.log(`AB test setup warnings: ${errorMessages}`, 'warn');
        postDeployWarnings.push(...errors.map(err => `AB test "${err.testName}": ${err.error}`));
      }
    }

    // Post-deploy: Enable CloudWatch Transaction Search (non-blocking, silent)
    const nextSteps = agentNames.length > 0 ? [...AGENT_NEXT_STEPS] : [...MEMORY_ONLY_NEXT_STEPS];
    const notes: string[] = [];
    if (agentNames.length > 0 || hasGateways) {
      try {
        const tsResult = await setupTransactionSearch({
          region: target.region,
          accountId: target.account,
          agentNames,
          hasGateways,
        });
        if (tsResult.error) {
          logger.log(`Transaction search setup warning: ${tsResult.error}`, 'warn');
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

    return {
      success: true,
      targetName: target.name,
      stackName,
      outputs,
      logPath: logger.getRelativeLogPath(),
      nextSteps,
      notes,
      postDeployWarnings: postDeployWarnings.length > 0 ? postDeployWarnings : undefined,
    };
  } catch (err: unknown) {
    logger.log(getErrorMessage(err), 'error');
    logger.finalize(false);
    return { success: false, error: getErrorMessage(err), logPath: logger.getRelativeLogPath() };
  } finally {
    if (toolkitWrapper) {
      await toolkitWrapper.dispose();
    }
    restoreEnv?.();
  }
}

/**
 * Resolve config bundle component key placeholders to real ARNs.
 *
 * Component keys like {{gateway:name}} or {{runtime:name}} are replaced
 * with the actual ARNs from deployed state. Keys that are already ARNs or
 * don't match a placeholder pattern are left unchanged.
 */
// resolveConfigBundleComponentKeys and resolveComponentKey moved to
// src/cli/operations/deploy/post-deploy-config-bundles.ts
