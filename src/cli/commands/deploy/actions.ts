import { ConfigIO } from '../../../lib';
import { createSwitchableIoHost } from '../../cdk/toolkit-lib';
import { buildDeployedState, getStackOutputs, parseAgentOutputs } from '../../cloudformation';
import { getErrorMessage } from '../../errors';
import { ExecLogger } from '../../logging';
import {
  bootstrapEnvironment,
  buildCdkProject,
  checkBootstrapNeeded,
  checkStackDeployability,
  hasOwnedIdentityApiProviders,
  setupApiKeyProviders,
  synthesizeCdk,
  validateProject,
} from '../../operations/deploy';
import type { DeployResult } from './types';

export interface ValidatedDeployOptions {
  target: string;
  autoConfirm?: boolean;
  verbose?: boolean;
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

    // Preflight: validate project
    startStep('Validate project');
    const context = await validateProject();
    endStep('success');

    // Ensure L3 constructs are linked (for local development)
    startStep('Link L3 constructs');
    await context.cdkProject.ensureL3Link();
    endStep('success');

    // Build CDK project
    startStep('Build CDK project');
    await buildCdkProject(context.cdkProject);
    endStep('success');

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

    // Set up identity providers if needed
    let identityKmsKeyArn: string | undefined;
    if (hasOwnedIdentityApiProviders(context.projectSpec)) {
      startStep('Set up API key providers');
      const identityResult = await setupApiKeyProviders({
        projectSpec: context.projectSpec,
        configBaseDir: configIO.getConfigRoot(),
        region: target.region,
        enableKmsEncryption: true,
      });
      if (identityResult.hasErrors) {
        const errorMsg = identityResult.results.find(r => r.status === 'error')?.error ?? 'Identity setup failed';
        endStep('error', errorMsg);
        logger.finalize(false);
        return { success: false, error: errorMsg, logPath: logger.getRelativeLogPath() };
      }
      identityKmsKeyArn = identityResult.kmsKeyArn;
      endStep('success');
    }

    // Deploy
    startStep('Deploy to AWS');

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

    // Get stack outputs and persist state
    startStep('Persist deployment state');
    const outputs = await getStackOutputs(target.region, stackName);
    const agentNames = context.projectSpec.agents.map(a => a.name);
    const agents = parseAgentOutputs(outputs, agentNames, stackName);
    const existingState = await configIO.readDeployedState().catch(() => undefined);
    const deployedState = buildDeployedState(target.name, stackName, agents, existingState, identityKmsKeyArn);
    await configIO.writeDeployedState(deployedState);
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
  } catch (err) {
    logger.log(getErrorMessage(err), 'error');
    logger.finalize(false);
    return { success: false, error: getErrorMessage(err), logPath: logger.getRelativeLogPath() };
  } finally {
    if (toolkitWrapper) {
      await toolkitWrapper.dispose();
    }
  }
}
