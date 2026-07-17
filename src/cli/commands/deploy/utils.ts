import type { DependencySyncResult } from '../../../lib/dependency-management';
import type { AgentCoreProjectSpec } from '../../../schema';
import type { DeployMode } from '../../telemetry/schemas/common-shapes';

export const DEFAULT_DEPLOY_ATTRS = {
  runtime_count: 0,
  harness_count: 0,
  memory_count: 0,
  credential_count: 0,
  evaluator_count: 0,
  online_eval_count: 0,
  gateway_count: 0,
  gateway_target_count: 0,
  policy_engine_count: 0,
  policy_count: 0,
  deploy_mode: 'deploy' as DeployMode,
};

/**
 * Map a managed-dependency sync outcome (#1540) to its dep_sync_* telemetry attrs.
 * Single source for both the CLI command (command.tsx) and the TUI flow (useDeployFlow).
 */
export function toDepSyncAttrs(sync: DependencySyncResult) {
  return {
    dep_sync_changed_count: sync.changes.length + sync.restored.length,
    dep_sync_migrated: sync.migrated,
    dep_sync_opted_out: sync.optedOut,
    dep_sync_skew_warning: sync.skewWarning,
    dep_sync_reinstalled: sync.reinstalled,
  };
}

export function computeDeployAttrs(projectSpec: Partial<AgentCoreProjectSpec>, mode: DeployMode) {
  const gateways = projectSpec.agentCoreGateways ?? [];
  const policyEngines = projectSpec.policyEngines ?? [];
  return {
    runtime_count: (projectSpec.runtimes ?? []).length,
    harness_count: (projectSpec.harnesses ?? []).length,
    memory_count: (projectSpec.memories ?? []).length,
    credential_count: (projectSpec.credentials ?? []).length,
    evaluator_count: (projectSpec.evaluators ?? []).length,
    online_eval_count: (projectSpec.onlineEvalConfigs ?? []).length,
    gateway_count: gateways.length,
    gateway_target_count: gateways.reduce((sum, g) => sum + (g.targets ?? []).length, 0),
    policy_engine_count: policyEngines.length,
    policy_count: policyEngines.reduce((sum, pe) => sum + (pe.policies ?? []).length, 0),
    deploy_mode: mode,
  };
}
