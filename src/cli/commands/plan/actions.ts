import { ConfigIO } from '../../../lib';
import { buildDeployedState, getStackOutputs, parseAgentOutputs } from '../../cloudformation';
import { getErrorMessage } from '../../errors';
import {
  bootstrapEnvironment,
  buildCdkProject,
  checkBootstrapNeeded,
  checkStackDeployability,
  synthesizeCdk,
  validateProject,
} from '../../operations/deploy';
import type { PlanResult } from './types';

export interface ValidatedPlanOptions {
  target: string;
  deploy?: boolean;
  autoConfirm?: boolean;
}

export async function handlePlan(options: ValidatedPlanOptions): Promise<PlanResult> {
  let toolkitWrapper = null;

  try {
    const configIO = new ConfigIO();

    // Load targets and find the specified one
    const targets = await configIO.readAWSDeploymentTargets();
    const target = targets.find(t => t.name === options.target);
    if (!target) {
      return { success: false, error: `Target "${options.target}" not found in aws-targets.json` };
    }

    // Preflight: validate project
    const context = await validateProject();

    // Build CDK project
    await buildCdkProject(context.cdkProject);

    // Synthesize CloudFormation templates
    const synthResult = await synthesizeCdk(context.cdkProject);
    toolkitWrapper = synthResult.toolkitWrapper;
    const stackNames = synthResult.stackNames;

    if (stackNames.length === 0) {
      return { success: false, error: 'No stacks found to deploy' };
    }

    const stackName = stackNames[0]!;

    // If --deploy flag is set, continue to deploy
    if (options.deploy) {
      // Check if bootstrap needed
      const bootstrapCheck = await checkBootstrapNeeded(context.awsTargets);
      if (bootstrapCheck.needsBootstrap) {
        if (options.autoConfirm) {
          await bootstrapEnvironment(toolkitWrapper, target);
        } else {
          return {
            success: false,
            error: 'AWS environment needs bootstrapping. Run with --yes to auto-bootstrap.',
          };
        }
      }

      // Check stack deployability
      const deployabilityCheck = await checkStackDeployability(target.region, stackNames);
      if (!deployabilityCheck.canDeploy) {
        return {
          success: false,
          error: deployabilityCheck.message ?? 'Stack is not in a deployable state',
        };
      }

      // Deploy
      await toolkitWrapper.deploy();

      // Get stack outputs and persist state
      const outputs = await getStackOutputs(target.region, stackName);
      const agentNames = context.projectSpec.agents.map(a => a.name);
      const agents = parseAgentOutputs(outputs, agentNames, stackName);
      const existingState = await configIO.readDeployedState().catch(() => undefined);
      const deployedState = buildDeployedState(target.name, stackName, agents, existingState);
      await configIO.writeDeployedState(deployedState);

      return {
        success: true,
        targetName: target.name,
        stackName,
        stackNames,
        outputs,
        message: `Deployed to '${target.name}' (stack: ${stackName})`,
      };
    }

    // Plan only - return what would be deployed
    const message = `Would deploy ${stackNames.length} stack${stackNames.length > 1 ? 's' : ''}: ${stackNames.join(', ')}`;

    return {
      success: true,
      targetName: options.target,
      stackNames,
      message,
    };
  } catch (err) {
    return { success: false, error: getErrorMessage(err) };
  } finally {
    if (toolkitWrapper) {
      await toolkitWrapper.dispose();
    }
  }
}
