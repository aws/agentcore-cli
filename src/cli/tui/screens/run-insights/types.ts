export type RunInsightsSource = 'agent' | 'online-eval-config';

export type RunInsightsSessionMode = 'lookback' | 'specific';

export type RunInsightsStep =
  | 'source'
  | 'agent'
  | 'insights'
  | 'sessions'
  | 'lookbackDays'
  | 'configArn'
  | 'name'
  | 'confirm';

export interface RunInsightsConfig {
  source: RunInsightsSource;
  agent: string;
  insights: string[];
  sessionMode: RunInsightsSessionMode;
  lookbackDays: number;
  sessionIds: string[];
  onlineEvalConfigArn: string;
  name: string;
}

export const RUN_INSIGHTS_STEP_LABELS: Record<RunInsightsStep, string> = {
  source: 'Source',
  agent: 'Agent',
  insights: 'Insights',
  sessions: 'Sessions',
  lookbackDays: 'Lookback',
  configArn: 'Config',
  name: 'Name',
  confirm: 'Confirm',
};

export const DEFAULT_LOOKBACK_DAYS = 7;

export const AVAILABLE_INSIGHTS = [
  {
    id: 'Builtin.Insight.FailureAnalysis',
    title: 'Failure Analysis',
    description: 'Detect failure patterns and generate root causes',
  },
  {
    id: 'Builtin.Insight.UserIntent',
    title: 'User Intent',
    description: 'Classify and cluster user intents from session transcripts',
  },
  {
    id: 'Builtin.Insight.ExecutionSummary',
    title: 'Execution Summary',
    description: 'Summarize execution patterns and tool usage across sessions',
  },
];

export const SOURCE_OPTIONS = [
  {
    id: 'agent' as const,
    title: 'Agent (CloudWatch)',
    description: "Pull sessions from a deployed agent's log group",
  },
  {
    id: 'online-eval-config' as const,
    title: 'Online eval config',
    description: 'Use sessions from an existing online eval config',
  },
];

export const SESSION_MODE_OPTIONS = [
  {
    id: 'lookback' as const,
    title: 'Lookback window',
    description: 'Use all sessions within N days',
  },
  {
    id: 'specific' as const,
    title: 'Specific sessions',
    description: 'Pick individual session IDs',
  },
];
