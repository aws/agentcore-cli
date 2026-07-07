// ─────────────────────────────────────────────────────────────────────────────
// Online Insights Config Flow Types
// ─────────────────────────────────────────────────────────────────────────────

export type AddOnlineInsightsStep = 'agent' | 'insights' | 'samplingRate' | 'clustering' | 'name' | 'confirm';

export interface AddOnlineInsightsConfig {
  name: string;
  agent: string;
  insights: string[];
  samplingRate: number;
  clusteringFrequencies: string[];
  enableOnCreate: boolean;
}

export const ONLINE_INSIGHTS_STEP_LABELS: Record<AddOnlineInsightsStep, string> = {
  agent: 'Agent',
  insights: 'Insights',
  samplingRate: 'Rate',
  clustering: 'Clustering',
  name: 'Name',
  confirm: 'Confirm',
};

export const DEFAULT_INSIGHTS_SAMPLING_RATE = 100;

export const AVAILABLE_INSIGHTS = [
  {
    id: 'Builtin.Insight.FailureAnalysis',
    title: 'Failure Analysis',
    description: 'Analyze failure patterns and root causes across sessions',
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

export const CLUSTERING_FREQUENCIES = [
  { id: 'DAILY', title: 'Daily' },
  { id: 'WEEKLY', title: 'Weekly' },
  { id: 'MONTHLY', title: 'Monthly' },
];
