import type { Result } from '../../../lib/result';

export interface RunInsightsOptions {
  agent?: string;
  insights: string[];
  /** Optional evaluator — required if chaining into `run recommendation --from-insights` */
  evaluators?: string[];
  onlineEvalConfigArn?: string;
  lookbackDays?: number;
  startTime?: string;
  endTime?: string;
  sessionIds?: string[];
  name?: string;
  region?: string;
  endpoint?: string;
  wait?: boolean;
  pollIntervalMs?: number;
  onProgress?: (status: string, message: string) => void;
  onStarted?: (info: { batchEvaluationId: string; region: string }) => void;
}

export interface InsightsRunRecord {
  batchEvaluationId: string;
  batchEvaluationArn: string;
  name: string;
  status: string;
  region: string;
  createdAt?: string;
  completedAt?: string;
  insights: string[];
  agent?: string;
  sessionCount?: number;
  sessionsCompleted?: number;
  sessionsFailed?: number;
}

export type RunInsightsResult = Result<{
  batchEvaluationId: string;
  batchEvaluationArn: string;
  name: string;
  status: string;
  region: string;
  sessionCount?: number;
  sessionsCompleted?: number;
  sessionsFailed?: number;
}> & { logFilePath?: string };
