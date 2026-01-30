import type { AgentCoreDeployedState, DeployedState, TargetDeployedState } from '../../schema';
import { getCredentialProvider } from '../aws';
import { toPascalId } from './logical-ids';
import { getStackName } from './stack-discovery';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';

export type StackOutputs = Record<string, string>;

/**
 * Fetch CloudFormation stack outputs.
 */
export async function getStackOutputs(region: string, stackName: string): Promise<StackOutputs> {
  const cfn = new CloudFormationClient({ region, credentials: getCredentialProvider() });
  const resp = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
  const stack = resp.Stacks?.[0];
  if (!stack) {
    throw new Error(`Stack ${stackName} not found`);
  }

  const outputs: StackOutputs = {};
  for (const output of stack.Outputs ?? []) {
    if (output.OutputKey && output.OutputValue) {
      outputs[output.OutputKey] = output.OutputValue;
    }
  }
  return outputs;
}

/**
 * Parse stack outputs into deployed state for agents.
 *
 * Output key pattern after logical ID simplification:
 * ApplicationAgent{AgentName}{OutputType}Output{Hash}
 *
 * Examples:
 * - ApplicationAgentAdvancedAgentRuntimeIdOutput3E11FAB4
 * - ApplicationAgentBasicStrandsRoleArnOutputF1FD8F36
 */
export function parseAgentOutputs(
  outputs: StackOutputs,
  agentNames: string[],
  _stackName: string
): Record<string, AgentCoreDeployedState> {
  const agents: Record<string, AgentCoreDeployedState> = {};

  // Map PascalCase agent names to original names for lookup
  const agentIdMap = new Map(agentNames.map(name => [toPascalId(name), name]));
  const outputsByAgent: Record<
    string,
    {
      runtimeId?: string;
      runtimeArn?: string;
      roleArn?: string;
      memoryIds?: string;
      browserId?: string;
      codeInterpreterId?: string;
    }
  > = {};

  // Match pattern: ApplicationAgent{AgentName}{OutputType}Output
  const outputPattern =
    /^ApplicationAgent(.+?)(RuntimeId|RuntimeArn|RoleArn|MemoryIds|BrowserId|CodeInterpreterId)Output/;

  for (const [key, value] of Object.entries(outputs)) {
    const match = outputPattern.exec(key);
    if (!match) continue;

    const logicalAgent = match[1];
    const outputType = match[2];
    if (!logicalAgent || !outputType) continue;

    // Look up original agent name from PascalCase version
    const agentName = agentIdMap.get(logicalAgent) ?? logicalAgent;

    outputsByAgent[agentName] ??= {};

    switch (outputType) {
      case 'RuntimeId':
        outputsByAgent[agentName].runtimeId = value;
        break;
      case 'RuntimeArn':
        outputsByAgent[agentName].runtimeArn = value;
        break;
      case 'RoleArn':
        outputsByAgent[agentName].roleArn = value;
        break;
      case 'MemoryIds':
        outputsByAgent[agentName].memoryIds = value;
        break;
      case 'BrowserId':
        outputsByAgent[agentName].browserId = value;
        break;
      case 'CodeInterpreterId':
        outputsByAgent[agentName].codeInterpreterId = value;
        break;
      default:
        break;
    }
  }

  for (const [agentName, agentOutputs] of Object.entries(outputsByAgent)) {
    if (!agentOutputs.runtimeId || !agentOutputs.runtimeArn || !agentOutputs.roleArn) {
      continue;
    }

    const state: AgentCoreDeployedState = {
      runtimeId: agentOutputs.runtimeId,
      runtimeArn: agentOutputs.runtimeArn,
      roleArn: agentOutputs.roleArn,
    };

    if (agentOutputs.memoryIds) {
      state.memoryIds = agentOutputs.memoryIds.split(',');
    }
    if (agentOutputs.browserId) {
      state.browserId = agentOutputs.browserId;
    }
    if (agentOutputs.codeInterpreterId) {
      state.codeInterpreterId = agentOutputs.codeInterpreterId;
    }

    agents[agentName] = state;
  }

  return agents;
}

/**
 * Build deployed state from stack outputs.
 */
export function buildDeployedState(
  targetName: string,
  stackName: string,
  agents: Record<string, AgentCoreDeployedState>,
  existingState?: DeployedState
): DeployedState {
  const targetState: TargetDeployedState = {
    resources: {
      agents,
      stackName,
    },
  };

  return {
    targets: {
      ...existingState?.targets,
      [targetName]: targetState,
    },
  };
}

/**
 * Get stack outputs by project name (discovers stack via tags).
 * Uses Resource Groups Tagging API to find the stack, then DescribeStacks for outputs.
 */
export async function getStackOutputsByProject(
  region: string,
  projectName: string,
  targetName = 'default'
): Promise<StackOutputs> {
  const stackName = await getStackName(region, projectName, targetName);
  if (!stackName) {
    throw new Error(`No AgentCore stack found for project "${projectName}" target "${targetName}"`);
  }
  return getStackOutputs(region, stackName);
}
