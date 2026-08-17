/**
 * GET /api/resources — the project resource graph the SPA's resources panel
 * renders, built from the resolved project spec. When a deployed-state
 * capability is injected, each resource gains a deploymentStatus and its
 * deployed identifiers, including pending-removal entries that exist only in
 * the deployed state. Resource types the reference exposed but this project
 * schema lacks (aws-targets regions, per-harness model/tool specs) are emitted
 * with their neutral defaults so the wire shape stays intact.
 */
import type { HttpResponse } from "../../../io/httpServer";
import type {
  ResourceAgent,
  ResourceCredential,
  ResourceGateway,
  ResourceHarness,
  ResourceMemory,
  ResourcesResponse,
} from "./api";
import { apiError, json } from "./respond";
import type { InspectorDeps, InspectorDeployedResources } from "./types";

export async function handleResources(deps: InspectorDeps): Promise<HttpResponse> {
  const project = deps.project;
  if (!project) return apiError(404, "No agentcore project found");

  try {
    const deployed = deps.aws?.deployedState ? await deps.aws.deployedState() : undefined;
    return json(200, buildResourcesResponse(project.name, project.spec, deployed));
  } catch {
    return apiError(500, "Failed to read project configuration");
  }
}

type Spec = NonNullable<InspectorDeps["project"]>["spec"];

function buildResourcesResponse(
  projectName: string,
  spec: Spec,
  deployed: InspectorDeployedResources | undefined,
): ResourcesResponse {
  // Only report statuses when deployed state is known; otherwise omit them.
  const status = deployed
    ? (entry: unknown) => (entry ? ("deployed" as const) : ("local-only" as const))
    : () => undefined;

  const agents: ResourceAgent[] = spec.runtimes.map((runtime) => {
    const deployedAgent = deployed?.runtimes?.[runtime.name];
    return {
      name: runtime.name,
      build: runtime.build,
      entrypoint: runtime.entrypoint,
      codeLocation: runtime.codeLocation,
      runtimeVersion: runtime.runtimeVersion ?? "",
      networkMode: runtime.networkMode ?? "PUBLIC",
      protocol: runtime.protocol ?? "HTTP",
      envVars: runtime.envVars?.map((envVar) => envVar.name) ?? [],
      deploymentStatus: status(deployedAgent),
      deployed: deployedAgent,
    };
  });
  for (const [name, deployedAgent] of removedEntries(deployed?.runtimes, agents)) {
    agents.push({
      name,
      build: "",
      entrypoint: "",
      codeLocation: "",
      runtimeVersion: "",
      networkMode: "",
      protocol: "",
      envVars: [],
      deploymentStatus: "pending-removal",
      deployed: deployedAgent,
    });
  }

  // Harness registry entries carry only name + path; model/tool details lived
  // in per-harness spec files the reference read separately.
  const harnesses: ResourceHarness[] = spec.harnesses.map((harness) => ({
    name: harness.name,
    model: "",
    tools: [],
    deploymentStatus: status(deployed?.harnesses?.[harness.name]),
    deployed: deployed?.harnesses?.[harness.name],
  }));
  for (const [name, deployedHarness] of removedEntries(deployed?.harnesses, harnesses)) {
    harnesses.push({
      name,
      model: "",
      tools: [],
      deploymentStatus: "pending-removal",
      deployed: deployedHarness,
    });
  }

  const memories: ResourceMemory[] = spec.memories.map((memory) => ({
    name: memory.name,
    strategies: memory.strategies.map((strategy) => ({
      type: strategy.type,
      namespaceTemplates: strategy.namespaceTemplates ?? strategy.namespaces ?? [],
    })),
    expiryDays: memory.eventExpiryDuration,
    deploymentStatus: status(deployed?.memories?.[memory.name]),
    deployed: deployed?.memories?.[memory.name],
  }));
  for (const [name, deployedMemory] of removedEntries(deployed?.memories, memories)) {
    memories.push({
      name,
      strategies: [],
      expiryDays: undefined,
      deploymentStatus: "pending-removal",
      deployed: deployedMemory,
    });
  }

  const credentials: ResourceCredential[] = spec.credentials.map((credential) => ({
    name: credential.name,
    type: credential.authorizerType,
    deploymentStatus: status(deployed?.credentials?.[credential.name]),
    deployed: deployed?.credentials?.[credential.name],
  }));
  for (const [name, deployedCredential] of removedEntries(deployed?.credentials, credentials)) {
    credentials.push({
      name,
      type: "",
      deploymentStatus: "pending-removal",
      deployed: deployedCredential,
    });
  }

  const gateways: ResourceGateway[] = spec.agentCoreGateways.map((gateway) => ({
    name: gateway.name,
    targets: gateway.targets.map((target) => ({
      name: target.toolDefinitions?.[0]?.name ?? target.name,
      targetType: target.targetType,
    })),
    deploymentStatus: status(deployed?.gateways?.[gateway.name]),
    deployed: deployed?.gateways?.[gateway.name],
  }));
  for (const [name, deployedGateway] of removedEntries(deployed?.gateways, gateways)) {
    gateways.push({
      name,
      targets: [],
      deploymentStatus: "pending-removal",
      deployed: deployedGateway,
    });
  }

  return {
    success: true,
    project: projectName,
    agents,
    harnesses,
    memories,
    credentials,
    gateways,
    mcpRuntimeTools: (spec.mcpRuntimeTools ?? []).map((tool) => ({
      name: tool.name,
      bindings: tool.bindings ?? [],
    })),
    evaluators: spec.evaluators.map((evaluator) => ({
      name: evaluator.name,
      level: evaluator.level,
      description: evaluator.description,
      configType: evaluator.config.codeBased ? "code-based" : "llm-as-a-judge",
    })),
    onlineEvalConfigs: spec.onlineEvalConfigs.map((config) => ({
      name: config.name,
      agent: config.agent,
      evaluators: config.evaluators,
      insights: config.insights,
      samplingRate: config.samplingRate,
      description: config.description,
      logGroupNames: config.logGroupNames,
      serviceNames: config.serviceNames,
    })),
    policyEngines: spec.policyEngines.map((engine) => ({
      name: engine.name,
      description: engine.description,
      policies: engine.policies.map((policy) => ({
        name: policy.name,
        description: policy.description,
      })),
    })),
    unassignedTargets: (spec.unassignedTargets ?? []).map((target) => ({
      name: target.name,
      targetType: target.targetType,
    })),
    // The project schema has no aws-targets equivalent yet.
    deploymentTargets: [],
  };
}

/** Deployed entries whose names no longer exist in the local spec. */
function removedEntries<T>(
  deployedByName: Record<string, T> | undefined,
  local: { name: string }[],
): [string, T][] {
  if (!deployedByName) return [];
  const localNames = new Set(local.map((entry) => entry.name));
  return Object.entries(deployedByName).filter(([name]) => !localNames.has(name));
}
