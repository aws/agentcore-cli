import { ConfigIO } from '../../../lib';
import type {
  AgentCoreMcpSpec,
  AgentCoreProjectSpec,
  AwsDeploymentTargets,
  DeployedResourceState,
  DeployedState,
} from '../../../schema';
import { getAgentRuntimeStatus } from '../../aws';
import { getEvaluator, getOnlineEvaluationConfig } from '../../aws/agentcore-control';
import { getErrorMessage } from '../../errors';
import { ExecLogger } from '../../logging';
import type { ResourceDeploymentState } from './constants';

export type { ResourceDeploymentState };

export interface ResourceStatusEntry {
  resourceType:
    | 'agent'
    | 'memory'
    | 'credential'
    | 'gateway'
    | 'evaluator'
    | 'online-eval'
    | 'policy-engine'
    | 'policy';
  name: string;
  deploymentState: ResourceDeploymentState;
  identifier?: string;
  detail?: string;
  error?: string;
}

export interface ProjectStatusResult {
  success: boolean;
  projectName: string;
  targetName: string;
  targetRegion?: string;
  resources: ResourceStatusEntry[];
  error?: string;
  logPath?: string;
}

export interface StatusContext {
  project: AgentCoreProjectSpec;
  deployedState: DeployedState;
  awsTargets: AwsDeploymentTargets;
  mcpSpec?: AgentCoreMcpSpec;
}

export interface RuntimeLookupResult {
  success: boolean;
  targetName?: string;
  runtimeId?: string;
  runtimeStatus?: string;
  error?: string;
  logPath?: string;
}

/**
 * Loads configuration required for status check.
 * Gracefully handles missing deployed-state by returning empty targets.
 */
export async function loadStatusConfig(configIO: ConfigIO = new ConfigIO()): Promise<StatusContext> {
  const [project, awsTargets, deployedState, mcpSpec] = await Promise.all([
    configIO.readProjectSpec(),
    configIO.readAWSDeploymentTargets(),
    configIO.configExists('state')
      ? configIO.readDeployedState()
      : (Promise.resolve({ targets: {} }) as Promise<DeployedState>),
    configIO.configExists('mcp') ? configIO.readMcpSpec() : Promise.resolve(undefined),
  ]);

  return { project, deployedState, awsTargets, mcpSpec };
}

/**
 * Diffs a set of local resources against deployed resources, producing status entries.
 * Shared logic for all resource types (agents, credentials, memories, gateways).
 */
function diffResourceSet<TLocal extends { name: string }, TDeployed>({
  resourceType,
  localItems,
  deployedRecord,
  getIdentifier,
  getLocalDetail,
  getDeployedKey,
}: {
  resourceType: ResourceStatusEntry['resourceType'];
  localItems: TLocal[];
  deployedRecord: Record<string, TDeployed>;
  getIdentifier: (deployed: TDeployed) => string | undefined;
  getLocalDetail?: (item: TLocal) => string | undefined;
  getDeployedKey?: (item: TLocal) => string;
}): ResourceStatusEntry[] {
  const entries: ResourceStatusEntry[] = [];
  const localKeys = new Set(localItems.map(item => (getDeployedKey ? getDeployedKey(item) : item.name)));

  for (const item of localItems) {
    const key = getDeployedKey ? getDeployedKey(item) : item.name;
    const deployed = deployedRecord[key];
    entries.push({
      resourceType,
      name: item.name,
      deploymentState: deployed ? 'deployed' : 'local-only',
      identifier: deployed ? getIdentifier(deployed) : undefined,
      detail: getLocalDetail?.(item),
    });
  }

  for (const [name, deployed] of Object.entries(deployedRecord)) {
    if (!localKeys.has(name)) {
      entries.push({
        resourceType,
        name,
        deploymentState: 'pending-removal',
        identifier: getIdentifier(deployed),
      });
    }
  }

  return entries;
}

export function computeResourceStatuses(
  project: AgentCoreProjectSpec,
  resources: DeployedResourceState | undefined,
  mcpSpec?: AgentCoreMcpSpec
): ResourceStatusEntry[] {
  const agents = diffResourceSet({
    resourceType: 'agent',
    localItems: project.agents,
    deployedRecord: resources?.agents ?? {},
    getIdentifier: deployed => deployed.runtimeArn,
  });

  const credentials = diffResourceSet({
    resourceType: 'credential',
    localItems: project.credentials,
    deployedRecord: resources?.credentials ?? {},
    getIdentifier: deployed => deployed.credentialProviderArn,
    getLocalDetail: item => item.type?.replace('CredentialProvider', ''),
  });

  const memories = diffResourceSet({
    resourceType: 'memory',
    localItems: project.memories,
    deployedRecord: resources?.memories ?? {},
    getIdentifier: deployed => deployed.memoryArn,
    getLocalDetail: item => {
      if (!item.strategies?.length) return undefined;
      return item.strategies.map(s => s.type).join(', ');
    },
  });

  const gateways = diffResourceSet({
    resourceType: 'gateway',
    localItems: mcpSpec?.agentCoreGateways ?? [],
    deployedRecord: resources?.mcp?.gateways ?? {},
    getIdentifier: deployed => deployed.gatewayId,
    getLocalDetail: item => {
      const count = item.targets?.length ?? 0;
      return count > 0 ? `${count} target${count !== 1 ? 's' : ''}` : undefined;
    },
  });

  const evaluators = diffResourceSet({
    resourceType: 'evaluator',
    localItems: project.evaluators ?? [],
    deployedRecord: resources?.evaluators ?? {},
    getIdentifier: deployed => deployed.evaluatorArn,
    getLocalDetail: item => `${item.level} — LLM-as-a-Judge`,
  });

  const onlineEvalConfigs = diffResourceSet({
    resourceType: 'online-eval',
    localItems: project.onlineEvalConfigs ?? [],
    deployedRecord: resources?.onlineEvalConfigs ?? {},
    getIdentifier: deployed => deployed.onlineEvaluationConfigArn,
    getLocalDetail: item =>
      `${item.evaluators.length} evaluator${item.evaluators.length !== 1 ? 's' : ''}, ${item.samplingRate}% sampling`,
  });

  const policyEngines = diffResourceSet({
    resourceType: 'policy-engine',
    localItems: project.policyEngines ?? [],
    deployedRecord: resources?.policyEngines ?? {},
    getIdentifier: deployed => deployed.policyEngineArn,
    getLocalDetail: item => {
      const count = item.policies?.length ?? 0;
      return count > 0 ? `${count} polic${count !== 1 ? 'ies' : 'y'}` : undefined;
    },
  });

  // Flatten all policies across all engines into a single list for diffing
  const localPolicies: { name: string; engineName: string }[] = [];
  for (const engine of project.policyEngines ?? []) {
    for (const policy of engine.policies) {
      localPolicies.push({ name: policy.name, engineName: engine.name });
    }
  }

  const policies = diffResourceSet({
    resourceType: 'policy',
    localItems: localPolicies,
    deployedRecord: resources?.policies ?? {},
    getIdentifier: deployed => deployed.policyArn,
    getLocalDetail: item => item.engineName,
    getDeployedKey: item => `${item.engineName}/${item.name}`,
  });

  return [
    ...agents,
    ...credentials,
    ...memories,
    ...gateways,
    ...evaluators,
    ...onlineEvalConfigs,
    ...policyEngines,
    ...policies,
  ];
}

export async function handleProjectStatus(
  context: StatusContext,
  options: { targetName?: string } = {}
): Promise<ProjectStatusResult> {
  const logger = new ExecLogger({ command: 'status' });
  const { project, deployedState, awsTargets, mcpSpec } = context;

  logger.startStep('Resolve target');
  const deployedTargetNames = Object.keys(deployedState.targets);
  const targetNames = deployedTargetNames.length > 0 ? deployedTargetNames : awsTargets.map(t => t.name);
  const selectedTargetName = options.targetName ?? targetNames[0];

  logger.log(`Project: ${project.name}`);
  logger.log(`Available targets: ${targetNames.length > 0 ? targetNames.join(', ') : '(none)'}`);
  logger.log(`Selected target: ${selectedTargetName ?? '(none)'}`);

  if (options.targetName && !targetNames.includes(options.targetName)) {
    const error =
      targetNames.length > 0
        ? `Target '${options.targetName}' not found. Available: ${targetNames.join(', ')}`
        : `Target '${options.targetName}' not found. No targets configured.`;
    logger.endStep('error', error);
    logger.finalize(false);
    return {
      success: false,
      projectName: project.name,
      targetName: options.targetName,
      resources: [],
      error,
      logPath: logger.getRelativeLogPath(),
    };
  }
  logger.endStep('success');

  logger.startStep('Compute resource statuses');
  const targetConfig = selectedTargetName ? awsTargets.find(t => t.name === selectedTargetName) : undefined;
  const targetResources = selectedTargetName ? deployedState.targets[selectedTargetName]?.resources : undefined;

  const resources = computeResourceStatuses(project, targetResources, mcpSpec);

  const deployed = resources.filter(r => r.deploymentState === 'deployed').length;
  const localOnly = resources.filter(r => r.deploymentState === 'local-only').length;
  const pendingRemoval = resources.filter(r => r.deploymentState === 'pending-removal').length;
  logger.log(
    `Resources: ${resources.length} total (${deployed} deployed, ${localOnly} local-only, ${pendingRemoval} pending-removal)`
  );
  for (const entry of resources) {
    logger.log(
      `  ${entry.resourceType}/${entry.name}: ${entry.deploymentState}${entry.identifier ? ` [${entry.identifier}]` : ''}`
    );
  }
  logger.endStep('success');

  // Enrich deployed agents with live runtime status (parallel, entries replaced by index)
  if (targetConfig) {
    const agentStates = targetResources?.agents ?? {};
    const deployedAgents = resources.filter(
      (e, _i) => e.resourceType === 'agent' && e.deploymentState === 'deployed' && agentStates[e.name]
    );

    if (deployedAgents.length > 0) {
      logger.startStep(
        `Fetch runtime status (${deployedAgents.length} agent${deployedAgents.length !== 1 ? 's' : ''})`
      );

      await Promise.all(
        resources.map(async (entry, i) => {
          if (entry.resourceType !== 'agent' || entry.deploymentState !== 'deployed') return;

          const agentState = agentStates[entry.name];
          if (!agentState) return;

          try {
            const runtimeStatus = await getAgentRuntimeStatus({
              region: targetConfig.region,
              runtimeId: agentState.runtimeId,
            });
            resources[i] = { ...entry, detail: runtimeStatus.status };
            logger.log(`  ${entry.name}: ${runtimeStatus.status} (${agentState.runtimeId})`);
          } catch (error) {
            const errorMsg = getErrorMessage(error);
            resources[i] = { ...entry, error: errorMsg };
            logger.log(`  ${entry.name}: ERROR - ${errorMsg}`, 'error');
          }
        })
      );

      const hasErrors = resources.some(r => r.error);
      logger.endStep(hasErrors ? 'error' : 'success');
    }

    // Enrich deployed evaluators with live status
    const evaluatorStates = targetResources?.evaluators ?? {};
    const deployedEvaluators = resources.filter(
      e => e.resourceType === 'evaluator' && e.deploymentState === 'deployed' && evaluatorStates[e.name]
    );

    if (deployedEvaluators.length > 0) {
      logger.startStep(
        `Fetch evaluator status (${deployedEvaluators.length} evaluator${deployedEvaluators.length !== 1 ? 's' : ''})`
      );

      await Promise.all(
        resources.map(async (entry, i) => {
          if (entry.resourceType !== 'evaluator' || entry.deploymentState !== 'deployed') return;

          const evalState = evaluatorStates[entry.name];
          if (!evalState) return;

          try {
            const evalResult = await getEvaluator({
              region: targetConfig.region,
              evaluatorId: evalState.evaluatorId,
            });
            resources[i] = { ...entry, detail: `${entry.detail} — ${evalResult.status}` };
            logger.log(`  ${entry.name}: ${evalResult.status} (${evalState.evaluatorId})`);
          } catch (error) {
            const errorMsg = getErrorMessage(error);
            resources[i] = { ...entry, error: errorMsg };
            logger.log(`  ${entry.name}: ERROR - ${errorMsg}`, 'error');
          }
        })
      );

      const hasEvalErrors = resources.some(r => r.resourceType === 'evaluator' && r.error);
      logger.endStep(hasEvalErrors ? 'error' : 'success');
    }

    // Enrich deployed online eval configs with live status
    const onlineEvalStates = targetResources?.onlineEvalConfigs ?? {};
    const deployedOnlineEvals = resources.filter(
      e => e.resourceType === 'online-eval' && e.deploymentState === 'deployed' && onlineEvalStates[e.name]
    );

    if (deployedOnlineEvals.length > 0) {
      logger.startStep(
        `Fetch online eval status (${deployedOnlineEvals.length} config${deployedOnlineEvals.length !== 1 ? 's' : ''})`
      );

      await Promise.all(
        resources.map(async (entry, i) => {
          if (entry.resourceType !== 'online-eval' || entry.deploymentState !== 'deployed') return;

          const configState = onlineEvalStates[entry.name];
          if (!configState) return;

          try {
            const configResult = await getOnlineEvaluationConfig({
              region: targetConfig.region,
              configId: configState.onlineEvaluationConfigId,
            });
            const statusLabel = `${configResult.status} (${configResult.executionStatus})`;
            const detail = entry.detail ? `${entry.detail} — ${statusLabel}` : statusLabel;
            resources[i] = { ...entry, detail };
            logger.log(`  ${entry.name}: ${statusLabel} (${configState.onlineEvaluationConfigId})`);
          } catch (error) {
            const errorMsg = getErrorMessage(error);
            resources[i] = { ...entry, error: errorMsg };
            logger.log(`  ${entry.name}: ERROR - ${errorMsg}`, 'error');
          }
        })
      );

      const hasOnlineEvalErrors = resources.some(r => r.resourceType === 'online-eval' && r.error);
      logger.endStep(hasOnlineEvalErrors ? 'error' : 'success');
    }
  }

  logger.finalize(true);
  return {
    success: true,
    projectName: project.name,
    targetName: selectedTargetName ?? '',
    targetRegion: targetConfig?.region,
    resources,
    logPath: logger.getRelativeLogPath(),
  };
}

export async function handleRuntimeLookup(
  context: StatusContext,
  options: { agentRuntimeId: string; targetName?: string }
): Promise<RuntimeLookupResult> {
  const logger = new ExecLogger({ command: 'status' });
  const { awsTargets } = context;

  logger.startStep('Resolve target');
  const targetNames = awsTargets.map(target => target.name);
  if (targetNames.length === 0) {
    const error = 'No deployment targets found. Run `agentcore create` first.';
    logger.endStep('error', error);
    logger.finalize(false);
    return { success: false, error, logPath: logger.getRelativeLogPath() };
  }

  const selectedTargetName = options.targetName ?? targetNames[0]!;

  if (options.targetName && !targetNames.includes(options.targetName)) {
    const error = `Target '${options.targetName}' not found. Available: ${targetNames.join(', ')}`;
    logger.endStep('error', error);
    logger.finalize(false);
    return { success: false, error, logPath: logger.getRelativeLogPath() };
  }

  const targetConfig = awsTargets.find(target => target.name === selectedTargetName);

  if (!targetConfig) {
    const error = `Target config '${selectedTargetName}' not found in aws-targets`;
    logger.endStep('error', error);
    logger.finalize(false);
    return { success: false, error, logPath: logger.getRelativeLogPath() };
  }

  logger.log(`Target: ${selectedTargetName} (${targetConfig.region})`);
  logger.endStep('success');

  logger.startStep(`Lookup runtime ${options.agentRuntimeId}`);
  try {
    const runtimeStatus = await getAgentRuntimeStatus({
      region: targetConfig.region,
      runtimeId: options.agentRuntimeId,
    });

    logger.log(`Runtime: ${runtimeStatus.runtimeId} — ${runtimeStatus.status}`);
    logger.endStep('success');
    logger.finalize(true);

    return {
      success: true,
      targetName: selectedTargetName,
      runtimeId: runtimeStatus.runtimeId,
      runtimeStatus: runtimeStatus.status,
      logPath: logger.getRelativeLogPath(),
    };
  } catch (error) {
    const errorMsg = getErrorMessage(error);
    logger.endStep('error', errorMsg);
    logger.finalize(false);
    return { success: false, error: errorMsg, logPath: logger.getRelativeLogPath() };
  }
}
