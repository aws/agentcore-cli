import type { AgentCoreProjectSpec } from '../../../schema';

export type DeployMode = 'deploy' | 'dry-run' | 'diff';

export const DEFAULT_DEPLOY_ATTRS = {
  runtime_count: 0,
  memory_count: 0,
  credential_count: 0,
  evaluator_count: 0,
  online_eval_count: 0,
  gateway_count: 0,
  gateway_target_count: 0,
  policy_engine_count: 0,
  policy_count: 0,
  mode: 'deploy' as DeployMode,
};

export function computeDeployAttrs(projectSpec: Partial<AgentCoreProjectSpec>, mode: DeployMode) {
  const gateways = projectSpec.agentCoreGateways ?? [];
  const policyEngines = projectSpec.policyEngines ?? [];
  return {
    runtime_count: (projectSpec.runtimes ?? []).length,
    memory_count: (projectSpec.memories ?? []).length,
    credential_count: (projectSpec.credentials ?? []).length,
    evaluator_count: (projectSpec.evaluators ?? []).length,
    online_eval_count: (projectSpec.onlineEvalConfigs ?? []).length,
    gateway_count: gateways.length,
    gateway_target_count: gateways.reduce((sum, g) => sum + (g.targets ?? []).length, 0),
    policy_engine_count: policyEngines.length,
    policy_count: policyEngines.reduce((sum, pe) => sum + (pe.policies ?? []).length, 0),
    mode,
  };
}
