import { ConfigIO, ResourceNotFoundError, toError } from '../../../lib';
import type { Result } from '../../../lib/result';
import type { AgentCoreProjectSpec, AwsDeploymentTargets, DeployedResourceState, DeployedState } from '../../../schema';
import { getAgentRuntimeStatus } from '../../aws';
import { getEvaluator, getOnlineEvaluationConfig } from '../../aws/agentcore-control';
import { getPaymentConnector, getPaymentManager } from '../../aws/agentcore-payments';
import { getKnowledgeBase, getLatestIngestionJob } from '../../aws/bedrock-agent';
import { getErrorMessage } from '../../errors';
import { ExecLogger } from '../../logging';
import type { ResourceDeploymentState } from './constants';
import { buildRuntimeInvocationUrl } from './constants';
import {
  type KbDataSourceDetail,
  type KbStatusDetail,
  formatKnowledgeBaseDetail,
  formatKnowledgeBaseSummaryLine,
} from './format-knowledge-base';

export type { ResourceDeploymentState };

export interface PaymentConnectorStatusEntry {
  name: string;
  connectorId: string;
  status: string;
  authorizationUrl?: string;
  credentialProviderArn?: string;
  error?: string;
}

export interface ResourceStatusEntry {
  resourceType:
    | 'agent'
    | 'memory'
    | 'credential'
    | 'gateway'
    | 'evaluator'
    | 'online-eval'
    | 'policy-engine'
    | 'policy'
    | 'config-bundle'
    | 'dataset'
    | 'harness'
    | 'runtime-endpoint'
    | 'knowledge-base'
    | 'payment'
    | 'capacity-provider';
  name: string;
  deploymentState: ResourceDeploymentState;
  identifier?: string;
  detail?: string;
  parentName?: string;
  error?: string;
  invocationUrl?: string;
  paymentConnectors?: PaymentConnectorStatusEntry[];
}

export type ProjectStatusResult = Result<{
  targetRegion?: string;
  resources: ResourceStatusEntry[];
  deployedState: DeployedState;
}> & { projectName?: string; targetName?: string; logPath?: string; resources?: ResourceStatusEntry[] };

export interface StatusContext {
  project: AgentCoreProjectSpec;
  deployedState: DeployedState;
  awsTargets: AwsDeploymentTargets;
}

export type RuntimeLookupResult = Result<{
  targetName?: string;
  runtimeId?: string;
  runtimeStatus?: string;
}> & { logPath?: string };

/**
 * Loads configuration required for status check.
 * Gracefully handles missing deployed-state by returning empty targets.
 */
export async function loadStatusConfig(configIO: ConfigIO = new ConfigIO()): Promise<StatusContext> {
  const [project, awsTargets, deployedState] = await Promise.all([
    configIO.readProjectSpec(),
    configIO.readAWSDeploymentTargets(),
    configIO.configExists('state')
      ? configIO.readDeployedState()
      : (Promise.resolve({ targets: {} }) as Promise<DeployedState>),
  ]);

  return { project, deployedState, awsTargets };
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
  getParentName,
}: {
  resourceType: ResourceStatusEntry['resourceType'];
  localItems: TLocal[];
  deployedRecord: Record<string, TDeployed>;
  getIdentifier: (deployed: TDeployed) => string | undefined;
  getLocalDetail?: (item: TLocal) => string | undefined;
  getDeployedKey?: (item: TLocal) => string;
  getParentName?: (item: TLocal) => string | undefined;
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
      parentName: getParentName?.(item),
    });
  }

  for (const [name, deployed] of Object.entries(deployedRecord)) {
    if (!localKeys.has(name)) {
      // For pending-removal entries, try to extract parentName from composite key
      const slashIdx = name.indexOf('/');
      entries.push({
        resourceType,
        name,
        deploymentState: 'pending-removal',
        identifier: getIdentifier(deployed),
        parentName: getParentName && slashIdx > 0 ? name.substring(0, slashIdx) : undefined,
      });
    }
  }

  return entries;
}

export function computeResourceStatuses(
  project: AgentCoreProjectSpec,
  resources: DeployedResourceState | undefined
): ResourceStatusEntry[] {
  const agents = diffResourceSet({
    resourceType: 'agent',
    localItems: project.runtimes,
    deployedRecord: resources?.runtimes ?? {},
    getIdentifier: deployed => deployed.runtimeArn,
  });

  const credentials = diffResourceSet({
    resourceType: 'credential',
    localItems: project.credentials,
    deployedRecord: resources?.credentials ?? {},
    getIdentifier: deployed => deployed.credentialProviderArn,
    getLocalDetail: item => item.authorizerType?.replace('CredentialProvider', ''),
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
    localItems: project.agentCoreGateways ?? [],
    deployedRecord: { ...(resources?.mcp?.gateways ?? {}), ...(resources?.gateways ?? {}) },
    getIdentifier: deployed => deployed.gatewayId,
    getLocalDetail: item => {
      const targets = item.targets ?? [];
      if (targets.length === 0) return undefined;
      const retrieveCount = targets.filter(
        t => t.targetType === 'connector' && t.connectorId === 'bedrock-knowledge-bases'
      ).length;
      const webSearchCount = targets.filter(t => t.targetType === 'connector' && t.connectorId === 'web-search').length;
      const base = `${targets.length} target${targets.length !== 1 ? 's' : ''}`;
      const parts: string[] = [];
      if (retrieveCount > 0) parts.push(`${retrieveCount} retrieve`);
      // Count agentic retrievers from AgenticRetrieveStream configurations within KB connector targets
      let agenticFanOut = 0;
      for (const t of targets) {
        if (t.targetType !== 'connector' || t.connectorId !== 'bedrock-knowledge-bases') continue;
        const agenticConfig = (t.configurations ?? []).find(c => c.name === 'AgenticRetrieveStream');
        if (agenticConfig) {
          const retrievers = agenticConfig.parameterValues?.retrievers as unknown[] | undefined;
          agenticFanOut += retrievers?.length ?? 0;
        }
      }
      if (agenticFanOut > 0) parts.push(`agentic ×${agenticFanOut}`);
      if (webSearchCount > 0) parts.push(`${webSearchCount} web-search`);
      return parts.length > 0 ? `${base} (${parts.join(', ')})` : base;
    },
  });

  const evaluators = diffResourceSet({
    resourceType: 'evaluator',
    localItems: project.evaluators ?? [],
    deployedRecord: resources?.evaluators ?? {},
    getIdentifier: deployed => deployed.evaluatorArn,
    getLocalDetail: item => `${item.level} — ${item.config.codeBased ? 'Code-based' : 'LLM-as-a-Judge'}`,
  });

  const onlineEvalConfigs = diffResourceSet({
    resourceType: 'online-eval',
    localItems: project.onlineEvalConfigs ?? [],
    deployedRecord: resources?.onlineEvalConfigs ?? {},
    getIdentifier: deployed => deployed.onlineEvaluationConfigArn,
    getLocalDetail: item =>
      `${(item.evaluators ?? []).length} evaluator${(item.evaluators ?? []).length !== 1 ? 's' : ''}, ${item.samplingRate}% sampling`,
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

  const configBundles = diffResourceSet({
    resourceType: 'config-bundle',
    localItems: project.configBundles ?? [],
    deployedRecord: resources?.configBundles ?? {},
    getIdentifier: deployed => deployed.bundleArn,
    getLocalDetail: item => item.description,
  });

  const datasets = diffResourceSet({
    resourceType: 'dataset',
    localItems: project.datasets ?? [],
    deployedRecord: resources?.datasets ?? {},
    getIdentifier: deployed => deployed.datasetArn,
    getLocalDetail: item => item.schemaType,
  });

  // Reverse-index: KB name -> list of gateways with a connector target referencing it.
  // Walks both Retrieve (knowledgeBaseId) and AgenticRetrieveStream (retrievers[])
  // configurations so a KB shows its wiring no matter which configuration references it.
  const kbToGateways = new Map<string, Set<string>>();
  const recordKbWiring = (kbRef: string, gatewayName: string): void => {
    const set = kbToGateways.get(kbRef) ?? new Set<string>();
    set.add(gatewayName);
    kbToGateways.set(kbRef, set);
  };
  for (const gw of project.agentCoreGateways ?? []) {
    for (const t of gw.targets ?? []) {
      if (t.targetType !== 'connector') continue;
      for (const cfg of t.configurations ?? []) {
        const pv = cfg.parameterValues;
        if (cfg.name === 'Retrieve') {
          const kbId = pv?.knowledgeBaseId as string | undefined;
          if (kbId) recordKbWiring(kbId, gw.name);
        }
        if (cfg.name === 'AgenticRetrieveStream') {
          const retrievers = pv?.retrievers as
            | { configuration?: { knowledgeBase?: { knowledgeBaseId?: string } } }[]
            | undefined;
          for (const r of retrievers ?? []) {
            const ref = r?.configuration?.knowledgeBase?.knowledgeBaseId;
            if (ref) recordKbWiring(ref, gw.name);
          }
        }
      }
    }
  }

  const knowledgeBases = diffResourceSet({
    resourceType: 'knowledge-base',
    localItems: project.knowledgeBases ?? [],
    deployedRecord: resources?.knowledgeBases ?? {},
    getIdentifier: deployed => deployed.knowledgeBaseArn,
    getLocalDetail: item => {
      const dsPart = `${item.dataSources.length} data source${item.dataSources.length === 1 ? '' : 's'}`;
      // Wave 2: connector target binds the KB to a gateway. Project-owned
      // KBs are stored by name on the connector target; external KBs are
      // stored as a literal id (which won't match a knowledgeBases[] entry).
      // Either way, we look up by name here — any extra hit (the spec's own
      // gateway field) is fine to fold in.
      const wiredGateways = new Set<string>(kbToGateways.get(item.name) ?? []);
      if (item.gateway) wiredGateways.add(item.gateway);
      if (wiredGateways.size === 0) return dsPart;
      return `${dsPart} → gw:${[...wiredGateways].join(',')}`;
    },
  });

  // Flatten runtime endpoints for diffing against deployed state
  const localEndpoints: { name: string; agentName: string; version: number; description?: string }[] = [];
  for (const runtime of project.runtimes) {
    if (runtime.endpoints) {
      for (const [epName, ep] of Object.entries(runtime.endpoints)) {
        localEndpoints.push({
          name: epName,
          agentName: runtime.name,
          version: ep.version,
          description: ep.description,
        });
      }
    }
  }

  const runtimeEndpoints = diffResourceSet({
    resourceType: 'runtime-endpoint',
    localItems: localEndpoints,
    deployedRecord: resources?.runtimeEndpoints ?? {},
    getIdentifier: deployed => deployed.endpointArn,
    getLocalDetail: item => `v${item.version}${item.description ? ` — ${item.description}` : ''}`,
    getDeployedKey: item => `${item.agentName}/${item.name}`,
    getParentName: item => item.agentName,
  });

  const harnesses = diffResourceSet({
    resourceType: 'harness',
    localItems: project.harnesses ?? [],
    deployedRecord: resources?.harnesses ?? {},
    getIdentifier: deployed => deployed.harnessArn,
    getLocalDetail: () => undefined,
  });

  // Config version: the harness Version is service-incremented and only known from deployed
  // state, so enrich each entry's detail post-pass rather than via getLocalDetail (local spec has none).
  for (const entry of harnesses) {
    const version = resources?.harnesses?.[entry.name]?.harnessVersion;
    if (version !== undefined) entry.detail = entry.detail ? `${entry.detail} v${version}` : `v${version}`;
  }

  const payments = diffResourceSet({
    resourceType: 'payment',
    localItems: project.payments ?? [],
    deployedRecord: resources?.payments ?? {},
    getIdentifier: deployed => deployed.managerArn,
    getLocalDetail: item =>
      `${item.authorizerType} — auto-pay ${item.autoPayment ? 'on' : 'off'} (${item.connectors.length} connector(s))`,
  });

  const capacityProviders = diffResourceSet({
    resourceType: 'capacity-provider',
    localItems: project.capacityProviders ?? [],
    deployedRecord: resources?.capacityProviders ?? {},
    getIdentifier: deployed => deployed.capacityProviderArn,
    getLocalDetail: item =>
      item.computeConfiguration.ec2Configuration.launchTemplateSource.launchParameters.operatingSystem,
  });

  return [
    ...agents,
    ...runtimeEndpoints,
    ...credentials,
    ...memories,
    ...gateways,
    ...evaluators,
    ...onlineEvalConfigs,
    ...policyEngines,
    ...policies,
    ...datasets,
    ...knowledgeBases,
    ...configBundles,
    ...harnesses,
    ...payments,
    ...capacityProviders,
  ];
}

export async function handleProjectStatus(
  context: StatusContext,
  options: { targetName?: string; knowledgeBaseName?: string } = {}
): Promise<ProjectStatusResult> {
  const logger = new ExecLogger({ command: 'status' });
  const { project, deployedState, awsTargets } = context;

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
      error: new Error(error),
      projectName: project.name,
      targetName: options.targetName,
      resources: [],
      logPath: logger.getRelativeLogPath(),
    };
  }
  logger.endStep('success');

  logger.startStep('Compute resource statuses');
  const targetConfig = selectedTargetName ? awsTargets.find(t => t.name === selectedTargetName) : undefined;
  const targetResources = selectedTargetName ? deployedState.targets[selectedTargetName]?.resources : undefined;

  const resources = computeResourceStatuses(project, targetResources);

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
    const agentStates = targetResources?.runtimes ?? {};
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

          const invocationUrl = entry.identifier
            ? buildRuntimeInvocationUrl(targetConfig.region, entry.identifier)
            : undefined;

          try {
            const runtimeStatus = await getAgentRuntimeStatus({
              region: targetConfig.region,
              runtimeId: agentState.runtimeId,
            });
            resources[i] = { ...entry, detail: runtimeStatus.status, invocationUrl };
            logger.log(`  ${entry.name}: ${runtimeStatus.status} (${agentState.runtimeId})`);
          } catch (error) {
            const errorMsg = getErrorMessage(error);
            resources[i] = { ...entry, error: errorMsg, invocationUrl };
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

    // Enrich deployed knowledge bases with live KB status + latest ingestion job stats
    const kbStates = targetResources?.knowledgeBases ?? {};
    const deployedKbs = resources.filter(
      e => e.resourceType === 'knowledge-base' && e.deploymentState === 'deployed' && kbStates[e.name]
    );

    if (deployedKbs.length > 0) {
      logger.startStep(`Fetch knowledge base status (${deployedKbs.length} KB${deployedKbs.length !== 1 ? 's' : ''})`);

      // Reverse-index: KB spec name -> gateways whose connector targets
      // reference it. Project-owned KBs are stored by *name* in connector
      // target configurations (Retrieve on `knowledgeBaseId`, AgenticRetrieveStream
      // on `retrievers[]`), so we key by the spec name (entry.name) below.
      const kbNameToGateways = new Map<string, Set<string>>();
      const recordKbWiring = (kbRef: string, gatewayName: string): void => {
        const set = kbNameToGateways.get(kbRef) ?? new Set<string>();
        set.add(gatewayName);
        kbNameToGateways.set(kbRef, set);
      };
      for (const gw of project.agentCoreGateways ?? []) {
        for (const t of gw.targets ?? []) {
          if (t.targetType !== 'connector') continue;
          for (const cfg of t.configurations ?? []) {
            const pv = cfg.parameterValues;
            if (cfg.name === 'Retrieve') {
              const kbId = pv?.knowledgeBaseId as string | undefined;
              if (kbId) recordKbWiring(kbId, gw.name);
            }
            if (cfg.name === 'AgenticRetrieveStream') {
              const retrievers = pv?.retrievers as
                | { configuration?: { knowledgeBase?: { knowledgeBaseId?: string } } }[]
                | undefined;
              for (const r of retrievers ?? []) {
                const ref = r?.configuration?.knowledgeBase?.knowledgeBaseId;
                if (ref) recordKbWiring(ref, gw.name);
              }
            }
          }
        }
      }

      await Promise.all(
        resources.map(async (entry, i) => {
          if (entry.resourceType !== 'knowledge-base' || entry.deploymentState !== 'deployed') return;

          const kbState = kbStates[entry.name];
          if (!kbState) return;

          try {
            const live = await getKnowledgeBase({
              region: targetConfig.region,
              knowledgeBaseId: kbState.knowledgeBaseId,
            });
            if (!live) {
              const outOfSync = 'out of sync (KB deleted out of band)';
              const detail = entry.detail ? `${entry.detail} — ${outOfSync}` : outOfSync;
              resources[i] = { ...entry, detail };
              logger.log(`  ${entry.name}: KB ${kbState.knowledgeBaseId} not found`, 'error');
              return;
            }

            // Fetch the latest ingestion job for EVERY data source, in parallel,
            // and map each into a per-DS detail for the rich formatter.
            const dataSources: KbDataSourceDetail[] = await Promise.all(
              kbState.dataSources.map(async ds => {
                const job = await getLatestIngestionJob({
                  region: targetConfig.region,
                  knowledgeBaseId: kbState.knowledgeBaseId,
                  dataSourceId: ds.dataSourceId,
                });
                if (!job) {
                  return { uri: ds.uri, dataSourceId: ds.dataSourceId };
                }
                const stats = job.statistics ?? {};
                // 'COMPLETE' is the SDK's terminal success status for ingestion
                // jobs; treat it as completed so the formatter shows a finish time.
                const succeeded = job.status === 'COMPLETE';
                return {
                  uri: ds.uri,
                  dataSourceId: ds.dataSourceId,
                  ingestion: {
                    status: job.status,
                    startedAt: job.startedAt?.toISOString(),
                    updatedAt: job.updatedAt?.toISOString(),
                    completedAt: succeeded ? job.updatedAt?.toISOString() : undefined,
                    scanned: stats.numberOfDocumentsScanned,
                    indexed: stats.numberOfNewDocumentsIndexed,
                    modified: stats.numberOfModifiedDocumentsIndexed,
                    failed: stats.numberOfDocumentsFailed,
                    deleted: stats.numberOfDocumentsDeleted,
                  },
                };
              })
            );

            const gatewayNames = [...(kbNameToGateways.get(entry.name) ?? new Set<string>())];

            const kbDetail: KbStatusDetail = {
              name: entry.name,
              knowledgeBaseId: kbState.knowledgeBaseId,
              status: live.status,
              gatewayNames,
              dataSources,
            };

            // Render branch: with --name (knowledgeBaseName) we drill into the
            // full multi-line block for the matched KB only; without it we emit a
            // single summary rollup line per KB so `agentcore status` stays
            // uncluttered when several KBs are deployed. Either way the structured
            // `detail` below stays a concise one-liner because it is both rendered
            // inline in the TUI and serialized in `--json` mode.
            if (options.knowledgeBaseName) {
              if (entry.name === options.knowledgeBaseName) {
                for (const line of formatKnowledgeBaseDetail(kbDetail)) {
                  logger.log(line);
                }
              }
            } else {
              logger.log(formatKnowledgeBaseSummaryLine(kbDetail));
            }

            const firstWithJob = dataSources.find(ds => ds.ingestion);
            const ingestionSummary = firstWithJob?.ingestion?.status
              ? `Ingestion: ${firstWithJob.ingestion.status}`
              : 'Ingestion: never run';
            const enriched = `Status: ${live.status ?? 'UNKNOWN'} — ${ingestionSummary}`;
            const detail = entry.detail ? `${entry.detail} — ${enriched}` : enriched;
            resources[i] = { ...entry, detail };
          } catch (error) {
            const errorMsg = getErrorMessage(error);
            resources[i] = { ...entry, error: errorMsg };
            logger.log(`  ${entry.name}: ERROR - ${errorMsg}`, 'error');
          }
        })
      );

      const hasKbErrors = resources.some(r => r.resourceType === 'knowledge-base' && r.error);
      logger.endStep(hasKbErrors ? 'error' : 'success');
    }

    // Enrich deployed payment managers with live status
    const paymentStates = targetResources?.payments ?? {};
    const deployedPayments = resources.filter(
      e => e.resourceType === 'payment' && e.deploymentState === 'deployed' && paymentStates[e.name]
    );

    if (deployedPayments.length > 0) {
      logger.startStep(
        `Fetch payment status (${deployedPayments.length} manager${deployedPayments.length !== 1 ? 's' : ''})`
      );

      await Promise.all(
        resources.map(async (entry, i) => {
          if (entry.resourceType !== 'payment' || entry.deploymentState !== 'deployed') return;

          const paymentState = paymentStates[entry.name];
          if (!paymentState) return;

          const connectorCount = Object.keys(paymentState.connectors ?? {}).length;

          try {
            const managerDetail = await getPaymentManager({
              region: targetConfig.region,
              paymentManagerId: paymentState.managerId,
            });
            const status = managerDetail?.status ?? 'unknown';
            resources[i] = { ...entry, detail: `${status} — ${connectorCount} connector(s)` };
            logger.log(`  ${entry.name}: ${status} (${paymentState.managerId})`);
          } catch (error) {
            const errorMsg = getErrorMessage(error);
            resources[i] = { ...entry, detail: `unknown — ${connectorCount} connector(s)`, error: errorMsg };
            logger.log(`  ${entry.name}: unknown (fetch failed) - ${errorMsg}`, 'error');
          }

          const paymentConnectors = await Promise.all(
            Object.entries(paymentState.connectors ?? {}).map(
              async ([connectorName, connectorState]): Promise<PaymentConnectorStatusEntry> => {
                try {
                  const detail = await getPaymentConnector({
                    region: targetConfig.region,
                    paymentManagerId: paymentState.managerId,
                    paymentConnectorId: connectorState.connectorId,
                  });
                  if (!detail) {
                    return {
                      name: connectorName,
                      connectorId: connectorState.connectorId,
                      status: 'NOT_FOUND',
                      error: 'Connector was not found by the Payments service',
                    };
                  }
                  const credentialProviderArn = detail.credentialProviderConfigurations
                    .map(
                      configuration =>
                        configuration.coinbaseCDP?.credentialProviderArn ??
                        configuration.stripePrivy?.credentialProviderArn
                    )
                    .find((arn): arn is string => Boolean(arn));
                  return {
                    name: connectorName,
                    connectorId: connectorState.connectorId,
                    status: detail.status,
                    ...(detail.status === 'PENDING_AUTHENTICATION' &&
                      detail.authorizationUrl && { authorizationUrl: detail.authorizationUrl }),
                    ...(credentialProviderArn && { credentialProviderArn }),
                  };
                } catch (error) {
                  return {
                    name: connectorName,
                    connectorId: connectorState.connectorId,
                    status: 'UNKNOWN',
                    error: getErrorMessage(error),
                  };
                }
              }
            )
          );
          resources[i] = { ...resources[i], paymentConnectors };
          for (const connector of paymentConnectors) {
            logger.log(
              `    ${connector.name}: ${connector.status} (${connector.connectorId})` +
                (connector.error ? ` - ${connector.error}` : ''),
              connector.error ? 'error' : undefined
            );
          }
        })
      );

      const hasPaymentErrors = resources.some(r => r.resourceType === 'payment' && r.error);
      logger.endStep(hasPaymentErrors ? 'error' : 'success');
    }
  }

  logger.finalize(true);
  return {
    success: true,
    projectName: project.name,
    targetName: selectedTargetName ?? '',
    targetRegion: targetConfig?.region,
    resources,
    deployedState,
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
    return { success: false, error: new ResourceNotFoundError(error), logPath: logger.getRelativeLogPath() };
  }

  const selectedTargetName = options.targetName ?? targetNames[0]!;

  if (options.targetName && !targetNames.includes(options.targetName)) {
    const error = `Target '${options.targetName}' not found. Available: ${targetNames.join(', ')}`;
    logger.endStep('error', error);
    logger.finalize(false);
    return { success: false, error: new ResourceNotFoundError(error), logPath: logger.getRelativeLogPath() };
  }

  const targetConfig = awsTargets.find(target => target.name === selectedTargetName);

  if (!targetConfig) {
    const error = `Target config '${selectedTargetName}' not found in aws-targets`;
    logger.endStep('error', error);
    logger.finalize(false);
    return { success: false, error: new ResourceNotFoundError(error), logPath: logger.getRelativeLogPath() };
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
    return { success: false, error: toError(error), logPath: logger.getRelativeLogPath() };
  }
}
