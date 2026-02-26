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
 * Parse stack outputs into deployed state for gateways.
 *
 * Output key pattern for gateways:
 * Gateway{GatewayName}UrlOutput{Hash}
 *
 * Examples:
 * - GatewayMyGatewayUrlOutput3E11FAB4
 */
export function parseGatewayOutputs(
  outputs: StackOutputs,
  gatewaySpecs: Record<string, unknown>
): Record<string, { gatewayId: string; gatewayArn: string; gatewayUrl?: string }> {
  const gateways: Record<string, { gatewayId: string; gatewayArn: string; gatewayUrl?: string }> = {};

  // Map PascalCase gateway names to original names for lookup
  const gatewayNames = Object.keys(gatewaySpecs);
  const gatewayIdMap = new Map(gatewayNames.map(name => [toPascalId(name), name]));

  // Match patterns: Gateway{Name}{Type}Output or McpGateway{Name}{Type}Output
  const outputPattern = /^(?:Mcp)?Gateway(.+?)(Id|Arn|Url)Output/;

  for (const [key, value] of Object.entries(outputs)) {
    const match = outputPattern.exec(key);
    if (!match) continue;

    const logicalGateway = match[1];
    const outputType = match[2];
    if (!logicalGateway || !outputType) continue;

    // Look up original gateway name from PascalCase version
    const gatewayName = gatewayIdMap.get(logicalGateway) ?? logicalGateway;

    gateways[gatewayName] ??= { gatewayId: gatewayName, gatewayArn: '' };

    if (outputType === 'Id') {
      gateways[gatewayName].gatewayId = value;
    } else if (outputType === 'Arn') {
      gateways[gatewayName].gatewayArn = value;
    } else if (outputType === 'Url') {
      gateways[gatewayName].gatewayUrl = value;
    }
  }

  return gateways;
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
  gateways: Record<string, { gatewayId: string; gatewayArn: string; gatewayUrl?: string }>,
  existingState?: DeployedState,
  identityKmsKeyArn?: string,
  credentials?: Record<string, { credentialProviderArn: string; clientSecretArn?: string; callbackUrl?: string }>
): DeployedState {
  const targetState: TargetDeployedState = {
    resources: {
      agents,
      stackName,
      identityKmsKeyArn,
    },
  };

  // Add MCP state if gateways exist
  if (Object.keys(gateways).length > 0) {
    targetState.resources!.mcp = {
      gateways,
    };
  }

  // Add credential state if credentials exist
  if (credentials && Object.keys(credentials).length > 0) {
    targetState.resources!.credentials = credentials;
  }

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
