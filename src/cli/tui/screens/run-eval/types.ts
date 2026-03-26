import type { EvaluatorItem } from '../online-eval/types';

export type RunEvalStep = 'agent' | 'evaluators' | 'days' | 'sessions' | 'confirm';

export interface RunEvalConfig {
  agent: string;
  evaluators: string[];
  days: number;
  sessionIds: string[];
}

export const RUN_EVAL_STEP_LABELS: Record<RunEvalStep, string> = {
  agent: 'Agent',
  evaluators: 'Evaluators',
  days: 'Lookback',
  sessions: 'Sessions',
  confirm: 'Confirm',
};

export const DEFAULT_LOOKBACK_DAYS = 7;

export interface AgentItem {
  name: string;
  build: string;
}

export interface RunEvalFlowData {
  agents: AgentItem[];
  evaluators: EvaluatorItem[];
}
