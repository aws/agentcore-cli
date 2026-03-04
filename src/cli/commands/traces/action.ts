import { ConfigIO } from '../../../lib';
import type { AgentCoreProjectSpec, AwsDeploymentTargets, DeployedState } from '../../../schema';
import { buildTraceConsoleUrl, getTrace, listTraces, parseRuntimeArn } from '../../operations/traces';
import type { TracesGetOptions, TracesListOptions } from './types';

export interface TracesContext {
  project: AgentCoreProjectSpec;
  deployedState: DeployedState;
  awsTargets: AwsDeploymentTargets;
}

export async function loadTracesConfig(configIO: ConfigIO = new ConfigIO()): Promise<TracesContext> {
  return {
    project: await configIO.readProjectSpec(),
    deployedState: await configIO.readDeployedState(),
    awsTargets: await configIO.readAWSDeploymentTargets(),
  };
}

interface ResolvedAgent {
  agentName: string;
  region: string;
  accountId: string;
  runtimeId: string;
  targetName: string;
}

function resolveAgent(context: TracesContext, options: { agent?: string }): ResolvedAgent | { error: string } {
  const { project, deployedState, awsTargets } = context;

  const targetNames = Object.keys(deployedState.targets);
  if (targetNames.length === 0) {
    return { error: 'No deployed targets found. Run `agentcore deploy` first.' };
  }

  const selectedTargetName = targetNames[0]!;
  const targetState = deployedState.targets[selectedTargetName];
  const targetConfig = awsTargets.find(t => t.name === selectedTargetName);
  if (!targetConfig) {
    return { error: `Target config '${selectedTargetName}' not found in aws-targets` };
  }

  if (project.agents.length === 0) {
    return { error: 'No agents defined in configuration' };
  }

  const agentNames = project.agents.map(a => a.name);
  if (!options.agent && project.agents.length > 1) {
    return { error: `Multiple agents found. Use --agent to specify one: ${agentNames.join(', ')}` };
  }

  const agentSpec = options.agent ? project.agents.find(a => a.name === options.agent) : project.agents[0];
  if (options.agent && !agentSpec) {
    return { error: `Agent '${options.agent}' not found. Available: ${agentNames.join(', ')}` };
  }
  if (!agentSpec) {
    return { error: 'No agents defined in configuration' };
  }

  const agentState = targetState?.resources?.agents?.[agentSpec.name];
  if (!agentState) {
    return { error: `Agent '${agentSpec.name}' is not deployed to target '${selectedTargetName}'` };
  }

  const parsed = parseRuntimeArn(agentState.runtimeArn);
  if (!parsed) {
    return { error: `Could not parse runtime ARN: ${agentState.runtimeArn}` };
  }

  return {
    agentName: agentSpec.name,
    region: targetConfig.region,
    accountId: parsed.accountId,
    runtimeId: parsed.runtimeId,
    targetName: selectedTargetName,
  };
}

export interface TracesListResult {
  success: boolean;
  agentName?: string;
  targetName?: string;
  consoleUrl?: string;
  traces?: { traceId: string; timestamp: string; sessionId?: string }[];
  error?: string;
}

export async function handleTracesList(context: TracesContext, options: TracesListOptions): Promise<TracesListResult> {
  const resolved = resolveAgent(context, options);
  if ('error' in resolved) {
    return { success: false, error: resolved.error };
  }

  const consoleUrl = buildTraceConsoleUrl({
    region: resolved.region,
    accountId: resolved.accountId,
    runtimeId: resolved.runtimeId,
    agentName: resolved.agentName,
  });

  const limit = options.limit ? parseInt(options.limit, 10) : 20;
  const result = await listTraces({
    region: resolved.region,
    runtimeId: resolved.runtimeId,
    agentName: resolved.agentName,
    limit,
  });

  if (!result.success) {
    return { success: false, error: result.error, consoleUrl };
  }

  return {
    success: true,
    agentName: resolved.agentName,
    targetName: resolved.targetName,
    consoleUrl,
    traces: result.traces,
  };
}

export interface TracesGetResult {
  success: boolean;
  agentName?: string;
  targetName?: string;
  consoleUrl?: string;
  filePath?: string;
  error?: string;
}

export async function handleTracesGet(
  context: TracesContext,
  traceId: string,
  options: TracesGetOptions
): Promise<TracesGetResult> {
  const resolved = resolveAgent(context, options);
  if ('error' in resolved) {
    return { success: false, error: resolved.error };
  }

  const consoleUrl = buildTraceConsoleUrl({
    region: resolved.region,
    accountId: resolved.accountId,
    runtimeId: resolved.runtimeId,
    agentName: resolved.agentName,
  });

  const result = await getTrace({
    region: resolved.region,
    runtimeId: resolved.runtimeId,
    agentName: resolved.agentName,
    traceId,
    outputPath: options.output,
  });

  if (!result.success) {
    return { success: false, error: result.error, consoleUrl };
  }

  return {
    success: true,
    agentName: resolved.agentName,
    targetName: resolved.targetName,
    consoleUrl,
    filePath: result.filePath,
  };
}
