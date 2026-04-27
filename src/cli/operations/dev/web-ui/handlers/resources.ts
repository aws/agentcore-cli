import { ConfigIO } from '../../../../../lib';
import type { DeployedState } from '../../../../../schema';
import { computeResourceStatuses } from '../../../../commands/status/action';
import { buildRuntimeInvocationUrl } from '../../../../commands/status/constants';
import type {
  ResourceAgent,
  ResourceCredential,
  ResourceDeploymentStatus,
  ResourceEvaluator,
  ResourceGateway,
  ResourceMemory,
  ResourceOnlineEvalConfig,
  ResourcePolicyEngine,
} from '../api-types';
import type { RouteContext } from './route-context';
import type { ServerResponse } from 'node:http';

/** GET /api/resources — returns the full project resource graph from config files */
export async function handleResources(ctx: RouteContext, res: ServerResponse, origin?: string): Promise<void> {
  const { configRoot, onLog } = ctx.options;

  if (!configRoot) {
    ctx.setCorsHeaders(res, origin);
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'No agentcore project found' }));
    return;
  }

  try {
    const configIO = new ConfigIO({ baseDir: configRoot });
    const project = await configIO.readProjectSpec();

    // Load deployed state to compute deployment statuses.
    // Gracefully fall back to empty targets if no state file exists yet.
    let deployedState: DeployedState = { targets: {} };
    if (configIO.configExists('state')) {
      try {
        deployedState = await configIO.readDeployedState();
      } catch {
        onLog?.('warn', 'Failed to read deployed state');
      }
    }

    // Pick the first target's resources for the diff (same heuristic as `agentcore status`)
    const firstTargetKey = Object.keys(deployedState.targets)[0];
    const targetResources = firstTargetKey ? deployedState.targets[firstTargetKey]?.resources : undefined;

    // Read AWS targets to resolve region for invocation URLs.
    let targetRegion: string | undefined;
    try {
      const awsTargets = await configIO.readAWSDeploymentTargets();
      const firstTarget = firstTargetKey ? awsTargets.find(t => t.name === firstTargetKey) : awsTargets[0];
      targetRegion = firstTarget?.region;
    } catch {
      // aws-targets.json may not exist yet — region will be undefined
    }

    // Compute deployment statuses using the same logic as `agentcore status`
    const resourceStatuses = computeResourceStatuses(project, targetResources);
    const statusByTypeAndName = new Map<string, ResourceDeploymentStatus>();
    for (const entry of resourceStatuses) {
      statusByTypeAndName.set(`${entry.resourceType}:${entry.name}`, entry.deploymentState);
    }

    // Build agents from local config
    const localAgentNames = new Set(project.runtimes.map(a => a.name));
    const agents: ResourceAgent[] = project.runtimes.map(a => {
      const deployed = targetResources?.runtimes?.[a.name];
      return {
        name: a.name,
        build: a.build,
        entrypoint: a.entrypoint,
        codeLocation: a.codeLocation,
        runtimeVersion: a.runtimeVersion ?? '',
        networkMode: a.networkMode ?? 'PUBLIC',
        protocol: a.protocol ?? 'HTTP',
        envVars: a.envVars?.map(e => e.name) ?? [],
        deploymentStatus: statusByTypeAndName.get(`agent:${a.name}`),
        deployed,
        invocationUrl:
          deployed?.runtimeArn && targetRegion
            ? buildRuntimeInvocationUrl(targetRegion, deployed.runtimeArn)
            : undefined,
      };
    });

    // Add pending-removal agents (exist in deployed state but removed from local config)
    for (const [name, deployed] of Object.entries(targetResources?.runtimes ?? {})) {
      if (!localAgentNames.has(name)) {
        agents.push({
          name,
          build: '',
          entrypoint: '',
          codeLocation: '',
          runtimeVersion: '',
          networkMode: '',
          protocol: '',
          envVars: [],
          deploymentStatus: 'pending-removal' as ResourceDeploymentStatus,
          deployed,
          invocationUrl:
            deployed.runtimeArn && targetRegion
              ? buildRuntimeInvocationUrl(targetRegion, deployed.runtimeArn)
              : undefined,
        });
      }
    }

    // Build memories from local config
    const localMemoryNames = new Set(project.memories.map(m => m.name));
    const memories: ResourceMemory[] = project.memories.map(m => ({
      name: m.name,
      strategies: m.strategies.map(s => ({
        type: s.type,
        namespaces: s.namespaces ?? [],
      })),
      expiryDays: m.eventExpiryDuration,
      deploymentStatus: statusByTypeAndName.get(`memory:${m.name}`),
      deployed: targetResources?.memories?.[m.name],
    }));

    // Add pending-removal memories
    for (const [name, deployed] of Object.entries(targetResources?.memories ?? {})) {
      if (!localMemoryNames.has(name)) {
        memories.push({
          name,
          strategies: [],
          expiryDays: undefined,
          deploymentStatus: 'pending-removal' as ResourceDeploymentStatus,
          deployed,
        });
      }
    }

    // Build credentials from local config
    const localCredentialNames = new Set(project.credentials.map(c => c.name));
    const credentials: ResourceCredential[] = project.credentials.map(c => ({
      name: c.name,
      type: c.authorizerType,
      deploymentStatus: statusByTypeAndName.get(`credential:${c.name}`),
      deployed: targetResources?.credentials?.[c.name],
    }));

    // Add pending-removal credentials
    for (const [name, deployed] of Object.entries(targetResources?.credentials ?? {})) {
      if (!localCredentialNames.has(name)) {
        credentials.push({
          name,
          type: '',
          deploymentStatus: 'pending-removal' as ResourceDeploymentStatus,
          deployed,
        });
      }
    }

    // Build gateways from local config
    const localGatewayNames = new Set((project.agentCoreGateways ?? []).map(g => g.name));
    const gateways: ResourceGateway[] = (project.agentCoreGateways ?? []).map(g => ({
      name: g.name,
      targets: g.targets.map(t => ({
        name: t.toolDefinitions?.[0]?.name ?? t.name,
        targetType: t.targetType,
      })),
      deploymentStatus: statusByTypeAndName.get(`gateway:${g.name}`),
      deployed: targetResources?.mcp?.gateways?.[g.name],
    }));

    // Add pending-removal gateways
    for (const [name, deployed] of Object.entries(targetResources?.mcp?.gateways ?? {})) {
      if (!localGatewayNames.has(name)) {
        gateways.push({
          name,
          targets: [],
          deploymentStatus: 'pending-removal' as ResourceDeploymentStatus,
          deployed,
        });
      }
    }

    const mcpRuntimeTools = (project.mcpRuntimeTools ?? []).map(t => ({
      name: t.name,
      bindings: t.bindings ?? [],
    }));

    // Build evaluators from local config
    const localEvaluatorNames = new Set(project.evaluators.map(e => e.name));
    const evaluators: ResourceEvaluator[] = project.evaluators.map(e => ({
      name: e.name,
      level: e.level,
      description: e.description,
      configType: e.config.codeBased ? ('code-based' as const) : ('llm-as-a-judge' as const),
      deploymentStatus: statusByTypeAndName.get(`evaluator:${e.name}`),
      deployed: targetResources?.evaluators?.[e.name],
    }));

    // Add pending-removal evaluators
    for (const [name, deployed] of Object.entries(targetResources?.evaluators ?? {})) {
      if (!localEvaluatorNames.has(name)) {
        evaluators.push({
          name,
          level: '',
          description: undefined,
          configType: 'llm-as-a-judge' as const,
          deploymentStatus: 'pending-removal' as ResourceDeploymentStatus,
          deployed,
        });
      }
    }

    // Build online eval configs from local config
    const localOnlineEvalNames = new Set(project.onlineEvalConfigs.map(o => o.name));
    const onlineEvalConfigs: ResourceOnlineEvalConfig[] = project.onlineEvalConfigs.map(o => ({
      name: o.name,
      agent: o.agent,
      evaluators: o.evaluators,
      samplingRate: o.samplingRate,
      description: o.description,
      deploymentStatus: statusByTypeAndName.get(`online-eval:${o.name}`),
      deployed: targetResources?.onlineEvalConfigs?.[o.name],
    }));

    // Add pending-removal online eval configs
    for (const [name, deployed] of Object.entries(targetResources?.onlineEvalConfigs ?? {})) {
      if (!localOnlineEvalNames.has(name)) {
        onlineEvalConfigs.push({
          name,
          agent: '',
          evaluators: [],
          samplingRate: 0,
          description: undefined,
          deploymentStatus: 'pending-removal' as ResourceDeploymentStatus,
          deployed,
        });
      }
    }

    // Build policy engines from local config
    const localPolicyEngineNames = new Set(project.policyEngines.map(pe => pe.name));
    const policyEngines: ResourcePolicyEngine[] = project.policyEngines.map(pe => ({
      name: pe.name,
      description: pe.description,
      policies: pe.policies.map(p => ({
        name: p.name,
        description: p.description,
        deploymentStatus: statusByTypeAndName.get(`policy:${pe.name}/${p.name}`),
        deployed: targetResources?.policies?.[`${pe.name}/${p.name}`] ?? targetResources?.policies?.[p.name],
      })),
      deploymentStatus: statusByTypeAndName.get(`policy-engine:${pe.name}`),
      deployed: targetResources?.policyEngines?.[pe.name],
    }));

    // Add pending-removal policy engines
    for (const [name, deployed] of Object.entries(targetResources?.policyEngines ?? {})) {
      if (!localPolicyEngineNames.has(name)) {
        policyEngines.push({
          name,
          description: undefined,
          policies: [],
          deploymentStatus: 'pending-removal' as ResourceDeploymentStatus,
          deployed,
        });
      }
    }

    const unassignedTargets = (project.unassignedTargets ?? []).map(t => ({
      name: t.name,
      targetType: t.targetType,
    }));

    ctx.setCorsHeaders(res, origin);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        success: true,
        project: project.name,
        agents,
        memories,
        credentials,
        gateways,
        mcpRuntimeTools,
        evaluators,
        onlineEvalConfigs,
        policyEngines,
        unassignedTargets,
      })
    );
  } catch (err) {
    onLog?.('error', `Failed to read resources: ${err instanceof Error ? err.message : String(err)}`);
    ctx.setCorsHeaders(res, origin);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Failed to read project configuration' }));
  }
}
