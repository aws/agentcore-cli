/**
 * Job Engine public API.
 *
 * Usage:
 *   const engine = createJobEngine(new ConfigIO());
 *   const r = await engine.start('recommendation', opts);
 *   const jobs = await engine.list({ type: 'recommendation' });
 */
export { createJobEngine } from './shared/engine';
export { isTerminal, JOB_CAPABILITIES, STORAGE_DIRS, TERMINAL_STATUSES, NOT_FOUND_STATUS } from './shared/constants';
export { regionFromArn } from './shared/region';
export { waitForTerminal } from './shared/wait';
export type { WaitForTerminalOptions } from './shared/wait';
export { runDatasetPhase1, BATCH_INGESTION_DELAY_MS } from './batch-evaluation/dataset-phase1';
export type { DatasetPhase1Result } from './batch-evaluation/dataset-phase1';

export type {
  JobEngine,
  JobType,
  JobRecord,
  JobRecordBase,
  RecommendationJobRecord,
  BatchEvaluationJobRecord,
  ABTestJobRecord,
  ABTestVariantSummary,
  ABTestMode,
  InsightsJobRecord,
  JobCapabilities,
  ListOptions,
  StartRecommendationJobOptions,
  StartBatchEvaluationJobOptions,
  StartABTestJobOptions,
  StartInsightsJobOptions,
  RecommendationInputSource,
  RecommendationTraceSource,
  BatchEvaluationSource,
  ToolDescJsonPath,
  RecommendationType,
  PausableJobType,
  PromotableJobType,
  StoppableJobType,
  DebuggableJobType,
  DebugCheckResult,
  FailureAnalysisResult,
  InsightFailureCategory,
} from './shared/types';
