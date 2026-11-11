import type { DeployableResource } from "../../../handlers/project/types";
import type { HttpResponse } from "../../../io/httpServer";
import { apiError, json } from "./respond";
import type { InspectorDeps } from "./types";

export async function handleResources(deps: InspectorDeps): Promise<HttpResponse> {
  const project = deps.project;
  if (!project) return apiError(404, "No agentcore project found");

  // The SPA shows the Local/Deployed switch and deployment badges from this
  // field, and omits them when it is absent, so a failed lookup degrades to that.
  const lookup = await deps.deploymentStatus?.().catch(() => undefined);
  const status = (resourceType: DeployableResource, name: string) => {
    const deploymentStatus = lookup?.(resourceType, name);
    return deploymentStatus === undefined ? {} : { deploymentStatus };
  };

  const spec = project.spec;
  // The literal is the wire contract. The SPA depends on these exact field names.
  const resources = {
    success: true,
    project: project.name,
    agents: spec.runtimes.map((runtime) => ({
      name: runtime.name,
      build: runtime.build,
      entrypoint: runtime.entrypoint,
      codeLocation: runtime.codeLocation,
      runtimeVersion: runtime.runtimeVersion ?? "",
      networkMode: runtime.networkMode ?? "PUBLIC",
      protocol: runtime.protocol ?? "HTTP",
      envVars: runtime.envVars?.map((envVar) => envVar.name) ?? [],
      ...status("runtime", runtime.name),
    })),
    // Project schema has no per-harness model or tool spec yet, so neutral defaults.
    harnesses: spec.harnesses.map((harness) => ({
      name: harness.name,
      model: "",
      tools: [],
      ...status("harness", harness.name),
    })),
    memories: spec.memories.map((memory) => ({
      name: memory.name,
      strategies: memory.strategies.map((strategy) => ({
        type: strategy.type,
        namespaceTemplates: strategy.namespaceTemplates ?? strategy.namespaces ?? [],
      })),
      expiryDays: memory.eventExpiryDuration,
      ...status("memory", memory.name),
    })),
    credentials: spec.credentials.map((credential) => ({
      name: credential.name,
      type: credential.authorizerType,
      ...status("credential", credential.name),
    })),
    gateways: spec.agentCoreGateways.map((gateway) => ({
      name: gateway.name,
      targets: gateway.targets.map((target) => ({
        name: target.toolDefinitions?.[0]?.name ?? target.name,
        targetType: target.targetType,
      })),
      ...status("gateway", gateway.name),
    })),
    toolRuntimes: (spec.toolRuntimes ?? []).map((tool) => ({
      name: tool.name,
      bindings: tool.bindings ?? [],
    })),
    evaluators: spec.evaluators.map((evaluator) => ({
      name: evaluator.name,
      level: evaluator.level,
      description: evaluator.description,
      configType: evaluator.config.codeBased ? "code-based" : "llm-as-a-judge",
      ...status("evaluator", evaluator.name),
    })),
    onlineEvalConfigs: spec.onlineEvalConfigs.map((config) => ({
      name: config.name,
      agent: config.agent,
      evaluators: config.evaluators,
      samplingRate: config.samplingRate,
      description: config.description,
      logGroupNames: config.logGroupNames,
      serviceNames: config.serviceNames,
      ...status("online-eval", config.name),
    })),
    policyEngines: spec.policyEngines.map((engine) => ({
      name: engine.name,
      description: engine.description,
      policies: engine.policies.map((policy) => ({
        name: policy.name,
        description: policy.description,
      })),
      ...status("policy-engine", engine.name),
    })),
    unassignedTargets: [],
    // Project schema has no aws-targets or deployed-state equivalent yet, so neutral defaults.
    deploymentTargets: [],
  };
  return json(200, resources);
}
