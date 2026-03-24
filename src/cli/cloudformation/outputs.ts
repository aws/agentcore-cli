import type {
  AgentCoreDeployedState,
  DeployedState,
  EvaluatorDeployedState,
  MemoryDeployedState,
  OnlineEvalDeployedState,
  PolicyDeployedState,
  PolicyEngineDeployedState,
  TargetDeployedState,
} from '../../schema';
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

  // Match pattern: Gateway{Name}{Type}Output{Hash}
  const outputPattern = /^Gateway(.+?)(Id|Arn|Url)Output/;

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
 * Parse stack outputs into deployed state for memories.
 *
 * Looks up outputs by constructing the expected key prefix from known memory names
 *
 * Output key pattern: ApplicationMemory{PascalName}(Id|Arn)Output{Hash}
 */
export function parseMemoryOutputs(outputs: StackOutputs, memoryNames: string[]): Record<string, MemoryDeployedState> {
  const memories: Record<string, MemoryDeployedState> = {};
  const outputKeys = Object.keys(outputs);

  for (const memoryName of memoryNames) {
    const pascal = toPascalId(memoryName);
    const idPrefix = `ApplicationMemory${pascal}IdOutput`;
    const arnPrefix = `ApplicationMemory${pascal}ArnOutput`;

    const idKey = outputKeys.find(k => k.startsWith(idPrefix));
    const arnKey = outputKeys.find(k => k.startsWith(arnPrefix));

    if (idKey && arnKey) {
      memories[memoryName] = {
        memoryId: outputs[idKey]!,
        memoryArn: outputs[arnKey]!,
      };
    }
  }

  return memories;
}

/**
 * Parse stack outputs into deployed state for evaluators.
 *
 * Output key pattern: ApplicationEvaluator{PascalName}(Id|Arn)Output{Hash}
 */
export function parseEvaluatorOutputs(
  outputs: StackOutputs,
  evaluatorNames: string[]
): Record<string, EvaluatorDeployedState> {
  const evaluators: Record<string, EvaluatorDeployedState> = {};
  const outputKeys = Object.keys(outputs);

  for (const evalName of evaluatorNames) {
    const pascal = toPascalId('Evaluator', evalName);
    const idPrefix = `Application${pascal}IdOutput`;
    const arnPrefix = `Application${pascal}ArnOutput`;

    const idKey = outputKeys.find(k => k.startsWith(idPrefix));
    const arnKey = outputKeys.find(k => k.startsWith(arnPrefix));

    if (idKey && arnKey) {
      evaluators[evalName] = {
        evaluatorId: outputs[idKey]!,
        evaluatorArn: outputs[arnKey]!,
      };
    }
  }

  return evaluators;
}

/**
 * Parse stack outputs into deployed state for online evaluation configs.
 *
 * Output key pattern: ApplicationOnlineEval{PascalName}(Id|Arn)Output{Hash}
 */
export function parseOnlineEvalOutputs(
  outputs: StackOutputs,
  onlineEvalNames: string[]
): Record<string, OnlineEvalDeployedState> {
  const configs: Record<string, OnlineEvalDeployedState> = {};
  const outputKeys = Object.keys(outputs);

  for (const configName of onlineEvalNames) {
    const pascal = toPascalId('OnlineEval', configName);
    const idPrefix = `Application${pascal}IdOutput`;
    const arnPrefix = `Application${pascal}ArnOutput`;

    const idKey = outputKeys.find(k => k.startsWith(idPrefix));
    const arnKey = outputKeys.find(k => k.startsWith(arnPrefix));

    if (idKey && arnKey) {
      configs[configName] = {
        onlineEvaluationConfigId: outputs[idKey]!,
        onlineEvaluationConfigArn: outputs[arnKey]!,
      };
    }
  }

  return configs;
}

/**
 * Parse stack outputs into deployed state for policy engines.
 *
 * Output key pattern: ApplicationPolicyEngine{PascalName}(Id|Arn)Output{Hash}
 */
export function parsePolicyEngineOutputs(
  outputs: StackOutputs,
  engineNames: string[]
): Record<string, PolicyEngineDeployedState> {
  const engines: Record<string, PolicyEngineDeployedState> = {};
  const outputKeys = Object.keys(outputs);

  for (const engineName of engineNames) {
    const pascal = toPascalId('PolicyEngine', engineName);
    const idPrefix = `Application${pascal}IdOutput`;
    const arnPrefix = `Application${pascal}ArnOutput`;

    const idKey = outputKeys.find(k => k.startsWith(idPrefix));
    const arnKey = outputKeys.find(k => k.startsWith(arnPrefix));

    if (idKey && arnKey) {
      engines[engineName] = {
        policyEngineId: outputs[idKey]!,
        policyEngineArn: outputs[arnKey]!,
      };
    }
  }

  return engines;
}

/**
 * Parse stack outputs into deployed state for policies.
 *
 * Output key pattern: ApplicationPolicy{EnginePascal}{PolicyPascal}(Id|Arn)Output{Hash}
 */
export function parsePolicyOutputs(
  outputs: StackOutputs,
  policySpecs: { engineName: string; policyName: string }[]
): Record<string, PolicyDeployedState> {
  const policies: Record<string, PolicyDeployedState> = {};
  const outputKeys = Object.keys(outputs);

  for (const { engineName, policyName } of policySpecs) {
    const pascal = toPascalId('Policy', engineName, policyName);
    const idPrefix = `Application${pascal}IdOutput`;
    const arnPrefix = `Application${pascal}ArnOutput`;

    const idKey = outputKeys.find(k => k.startsWith(idPrefix));
    const arnKey = outputKeys.find(k => k.startsWith(arnPrefix));

    if (idKey && arnKey) {
      // Use engineName/policyName as the key for unique identification
      const key = `${engineName}/${policyName}`;
      policies[key] = {
        policyId: outputs[idKey]!,
        policyArn: outputs[arnKey]!,
        engineName,
      };
    }
  }

  return policies;
}

export interface BuildDeployedStateOptions {
  targetName: string;
  stackName: string;
  agents: Record<string, AgentCoreDeployedState>;
  gateways: Record<string, { gatewayId: string; gatewayArn: string; gatewayUrl?: string }>;
  existingState?: DeployedState;
  identityKmsKeyArn?: string;
  credentials?: Record<string, { credentialProviderArn: string; clientSecretArn?: string; callbackUrl?: string }>;
  memories?: Record<string, MemoryDeployedState>;
  evaluators?: Record<string, EvaluatorDeployedState>;
  onlineEvalConfigs?: Record<string, OnlineEvalDeployedState>;
  policyEngines?: Record<string, PolicyEngineDeployedState>;
  policies?: Record<string, PolicyDeployedState>;
}

/**
 * Build deployed state from stack outputs.
 */
export function buildDeployedState(opts: BuildDeployedStateOptions): DeployedState {
  const {
    targetName,
    stackName,
    agents,
    gateways,
    existingState,
    identityKmsKeyArn,
    credentials,
    memories,
    evaluators,
    onlineEvalConfigs,
    policyEngines,
    policies,
  } = opts;
  const targetState: TargetDeployedState = {
    resources: {
      agents: Object.keys(agents).length > 0 ? agents : undefined,
      memories: memories && Object.keys(memories).length > 0 ? memories : undefined,
      policyEngines: policyEngines && Object.keys(policyEngines).length > 0 ? policyEngines : undefined,
      policies: policies && Object.keys(policies).length > 0 ? policies : undefined,
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

  // Add evaluator state if evaluators exist
  if (evaluators && Object.keys(evaluators).length > 0) {
    targetState.resources!.evaluators = evaluators;
  }

  // Add online eval config state if configs exist
  if (onlineEvalConfigs && Object.keys(onlineEvalConfigs).length > 0) {
    targetState.resources!.onlineEvalConfigs = onlineEvalConfigs;
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
