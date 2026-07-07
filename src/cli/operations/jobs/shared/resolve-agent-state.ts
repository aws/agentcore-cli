/**
 * Resolve a deployed agent runtime from deployed state by name.
 * Hoisted here to dedupe the copies previously inlined in run-recommendation.ts and
 * run-batch-evaluation.ts.
 */
import type { DeployedState } from '../../../../schema';

export interface ResolvedAgentState {
  runtimeId: string;
  runtimeArn: string;
  roleArn?: string;
}

/** Find the agent runtime across all deployment targets; undefined if not deployed. */
export function resolveAgentState(deployedState: DeployedState, agentName: string): ResolvedAgentState | undefined {
  for (const target of Object.values(deployedState.targets)) {
    const agent = target.resources?.runtimes?.[agentName];
    if (agent) return agent;
  }
  return undefined;
}
