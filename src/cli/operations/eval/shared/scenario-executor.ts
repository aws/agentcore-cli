/**
 * Execute dataset scenarios against a deployed agent.
 *
 * Invokes the agent for each scenario's turns sequentially within a session,
 * running up to 5 scenarios concurrently. Halts a scenario on turn failure.
 */
import { invokeAgentRuntime } from '../../../aws/agentcore';
import type { AgentContext } from '../../invoke/resolve-agent-context';
import { generateSessionId } from '../../session';
import type { PredefinedScenario } from './types';

/** Maximum concurrent scenario executions. */
const MAX_CONCURRENT = 5;

export interface ScenarioInvocationResult {
  scenarioId: string;
  sessionId: string;
  turnCount: number;
  status: 'success' | 'failed';
  error?: string;
}

export interface ExecuteScenariosOptions {
  scenarios: PredefinedScenario[];
  agentContext: AgentContext;
  onProgress?: (completed: number, total: number, current: ScenarioInvocationResult) => void;
}

/**
 * Execute all scenarios concurrently (max 5 at a time).
 * Each scenario invokes all turns sequentially in one session.
 * Halts on turn failure — marks entire scenario as FAILED.
 */
export async function executeScenarios(options: ExecuteScenariosOptions): Promise<ScenarioInvocationResult[]> {
  const { scenarios, agentContext, onProgress } = options;
  const results: ScenarioInvocationResult[] = new Array<ScenarioInvocationResult>(scenarios.length);
  let nextIndex = 0;
  let completedCount = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = nextIndex++;
      if (i >= scenarios.length) return;
      const result = await executeSingleScenario(scenarios[i]!, agentContext);
      results[i] = result;
      completedCount++;
      onProgress?.(completedCount, scenarios.length, result);
    }
  }

  const workers = Array.from({ length: Math.min(MAX_CONCURRENT, scenarios.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Execute a single scenario: invoke all turns sequentially in one session.
 * Halts on first turn failure.
 */
async function executeSingleScenario(
  scenario: PredefinedScenario,
  ctx: AgentContext
): Promise<ScenarioInvocationResult> {
  const sessionId = generateSessionId();

  try {
    for (const turn of scenario.turns) {
      await invokeAgentRuntime({
        region: ctx.region,
        runtimeArn: ctx.runtimeArn,
        payload: turn.input,
        sessionId,
        bearerToken: ctx.bearerToken,
        baggage: ctx.baggage,
        endpoint: ctx.endpoint,
      });
    }

    return {
      scenarioId: scenario.scenario_id,
      sessionId: sessionId,
      turnCount: scenario.turns.length,
      status: 'success',
    };
  } catch (err) {
    return {
      scenarioId: scenario.scenario_id,
      sessionId: sessionId,
      turnCount: scenario.turns.length,
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
