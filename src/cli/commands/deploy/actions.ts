import { ConfigIO, SecureCredentials } from '../../../lib';
import type { DeployedState } from '../../../schema';
import { validateAwsCredentials } from '../../aws/account';
import { createSwitchableIoHost } from '../../cdk/toolkit-lib';
import { buildDeployedState, getStackOutputs, parseAgentOutputs, parseGatewayOutputs } from '../../cloudformation';
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
  synthesizeCdk,
  validateProject,
} from '../../operations/deploy';
import { formatTargetStatus, getGatewayTargetStatuses } from '../../operations/deploy/gateway-status';
import type { DeployResult } from './types';

export interface ValidatedDeployOptions {
  target: string;
  autoConfirm?: boolean;
  verbose?: boolean;
  plan?: boolean;
  onProgress?: (step: string, status: 'start' | 'success' | 'error') => void;
  onResourceEvent?: (message: string) => void;
}

const NEXT_STEPS = ['agentcore invoke', 'agentcore status'];

export async function handleDeploy(options: ValidatedDeployOptions): Promise<DeployResult> {
  let toolkitWrapper = null;
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
    const targets = await configIO.readAWSDeploymentTargets();
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
    endStep('success');

    // Read MCP spec for gateway information
    let mcpSpec;
    try {
      mcpSpec = await configIO.readMcpSpec();
    } catch {
      // No mcp.json or invalid — no gateways
      mcpSpec = null;
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

    // Deploy
    const hasGateways = mcpSpec?.agentCoreGateways && mcpSpec.agentCoreGateways.length > 0;
    const deployStepName = hasGateways ? 'Deploying gateways...' : 'Deploy to AWS';
    startStep(deployStepName);

    // Enable verbose output for resource-level events
    if (switchableIoHost && options.onResourceEvent) {
      switchableIoHost.setOnMessage(msg => {
        options.onResourceEvent!(msg.message);
      });
      switchableIoHost.setVerbose(true);
    }

    await toolkitWrapper.deploy();

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
    const agentNames = context.projectSpec.agents?.map(a => a.name) || [];
    const agents = parseAgentOutputs(outputs, agentNames, stackName);

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
    const deployedState = buildDeployedState(
      target.name,
      stackName,
      agents,
      gateways,
      existingState,
      identityKmsKeyArn,
      deployedCredentials
    );
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

    logger.finalize(true);

    return {
      success: true,
      targetName: target.name,
      stackName,
      outputs,
      logPath: logger.getRelativeLogPath(),
      nextSteps: NEXT_STEPS,
    };
  } catch (err: unknown) {
    logger.log(getErrorMessage(err), 'error');
    logger.finalize(false);
    return { success: false, error: getErrorMessage(err), logPath: logger.getRelativeLogPath() };
  } finally {
    if (toolkitWrapper) {
      await toolkitWrapper.dispose();
    }
  }
}
