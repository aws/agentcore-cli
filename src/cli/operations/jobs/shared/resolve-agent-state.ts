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
  /** Deployment target the runtime was found in. */
  targetName: string;
}

/** Find the agent runtime across all deployment targets; undefined if not deployed. */
export function resolveAgentState(deployedState: DeployedState, agentName: string): ResolvedAgentState | undefined {
  for (const [targetName, target] of Object.entries(deployedState.targets)) {
    const agent = target.resources?.runtimes?.[agentName];
    if (agent) return { ...agent, targetName };
  }
  return undefined;
}
