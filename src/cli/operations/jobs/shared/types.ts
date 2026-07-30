/**
 * Job Engine type system (Design 2 — composed traits + type-narrowed signatures).
 *
 * A "job" is an async, fire-and-forget operation (recommendation or batch evaluation):
 * `start` makes one API call + saves a local record; `get`/`list` refresh non-terminal
 * records on read. Handlers are composed from small traits; the engine's public surface
 * is type-narrowed so illegal operations (e.g. stopping a recommendation) are compile errors.
 */
import type { ConfigIO } from '../../../../lib';
import type { Result } from '../../../../lib/result';
import type { ABTestEvaluationConfig, ABTestResults, GatewayFilter } from '../../../aws/agentcore-ab-tests';
import type {
  BatchEvaluationResultEntry,
  EvaluationResults,
  SessionMetadataEntry,
} from '../../../aws/agentcore-batch-evaluation';
import type { RecommendationResult, RecommendationType } from '../../../aws/agentcore-recommendation';

export type { RecommendationType } from '../../../aws/agentcore-recommendation';

// ============================================================================
// Job types & statuses
// ============================================================================

/** The job types this engine manages. */
export type JobType = 'recommendation' | 'batch-evaluation' | 'ab-test' | 'insights';

/** AB test creation mode — bundle-versioned variants vs gateway-target variants. */
export type ABTestMode = 'config-bundle' | 'target-based';

/** CLI-facing input source for a recommendation. */
export type RecommendationInputSource = 'config-bundle' | 'inline' | 'file';

/** CLI-facing trace source for a recommendation. */
export type RecommendationTraceSource = 'cloudwatch' | 'sessions' | 'spans-file' | 'batch-evaluation';

/** Where the batch evaluation sessions came from. */
export type BatchEvaluationSource = 'traces' | 'dataset';

/** Tool name → JSONPath pairs for config-bundle tool descriptions. */
export interface ToolDescJsonPath {
  toolName: string;
  toolDescriptionJsonPath: string;
}

// ============================================================================
// Records (discriminated union on `type`)
// ============================================================================

/** Fields every job record carries, regardless of type. Note: region is NOT stored — parse from `arn`. */
export interface JobRecordBase {
  /** Job type discriminator. */
  type: JobType;
  /** Service-assigned job id (also the storage filename). */
  id: string;
  /** Service ARN — region is parsed back out of this for refresh/stop/archive. */
  arn: string;
  /** Latest known status (raw service string; may be a value not in the JobStatus union). */
  status: string;
  /** ISO timestamp the job was created (API value, else local clock at create time). */
  createdAt: string;
  /** ISO timestamp the job reached a terminal state. */
  completedAt?: string;
  /** Agent the job ran against. */
  agent: string;
  /** Path to the local ExecLogger trace for the start call. */
  logFilePath?: string;
  /** Persistent error from the last failed refresh (after retries exhausted). Settles the record. */
  error?: string;
}

export interface RecommendationJobRecord extends JobRecordBase {
  type: 'recommendation';
  recommendationType: RecommendationType;
  /** Raw user-supplied evaluator display name(s) (resolved to ARNs only transiently for the API). */
  evaluators: string[];
  inputSource: RecommendationInputSource;
  /** Source config-bundle identity (needed by the apply-to-bundle settle step). */
  bundleName?: string;
  bundleArn?: string;
  bundleVersion?: string;
  systemPromptJsonPath?: string;
  toolDescJsonPaths?: ToolDescJsonPath[];
  /** Optimized artifact, populated by refresh() once COMPLETED. */
  result?: RecommendationResult;
  /** Top-level failure reasons from the API (FAILED only). */
  statusReasons?: string[];
  /** Flattened failure detail (errorCode/errorMessage) for display (FAILED only). */
  failureDetail?: string;
  /** New config-bundle version already synced to agentcore.json (idempotency guard for settle). */
  syncedVersionId?: string;
  /** Customer-managed KMS key ARN used to encrypt results (echoes the --kms-key value sent at create). */
  kmsKeyArn?: string;
}

export interface BatchEvaluationJobRecord extends JobRecordBase {
  type: 'batch-evaluation';
  name: string;
  /** Resolved evaluator ids sent to the API (short ids / Builtin.*). */
  evaluators: string[];
  source?: BatchEvaluationSource;
  dataset?: { id: string; version: string };
  /** Server-computed evaluator summaries (from GetBatchEvaluation). */
  evaluationResults?: EvaluationResults;
  /** Per-session scores fetched from CloudWatch output logs on terminal status. */
  results?: BatchEvaluationResultEntry[];
  /** True once per-session results have been fetched (gates the on-terminal retry). */
  resultsFetched?: boolean;
  /** Customer-managed KMS key ARN used to encrypt results (echoes --kms-key; refreshed from GetBatchEvaluation). */
  kmsKeyArn?: string;
}

/** Variant summary stored on the AB-test record (the resolved ARNs/targets sent to the API). */
export interface ABTestVariantSummary {
  name: 'C' | 'T1';
  weight: number;
  bundleArn?: string;
  bundleVersion?: string;
  targetName?: string;
}

export interface ABTestJobRecord extends JobRecordBase {
  type: 'ab-test';
  /**
   * AB test has two API axes: `status` (ACTIVE/FAILED/CREATE_FAILED) and `executionStatus`
   * (RUNNING/PAUSED/STOPPED). We store lifecycle `status` in JobRecordBase.status (so
   * isTerminal() works like other job types), and keep `executionStatus` here for
   * keybinding gating (P/R/S).
   */
  lifecycleStatus: string;
  name: string;
  mode: ABTestMode;
  gatewayArn: string;
  /** Gateway NAME (spec key) — needed by promote() to locate gateway targets in agentcore.json. */
  gatewayName?: string;
  /**
   * Config-bundle mode: the gateway target routing to the runtime under test, resolved at create time
   * and used as the invocation URL's path segment. Set only when exactly one target matches; when several
   * match it is left unset and `targetCandidates` lists them instead (see resolveRuntimeTargetNames).
   */
  targetName?: string;
  /**
   * Config-bundle mode: the gateway targets routing to the runtime when more than one matches, so the
   * user can pick a path. Unset when a single target resolved (that goes in `targetName`).
   */
  targetCandidates?: string[];
  roleArn?: string;
  /** True when the CLI auto-created the role in create() (so archive() cleans it up). */
  roleCreatedByCli?: boolean;
  variants: ABTestVariantSummary[];
  evaluationConfig: ABTestEvaluationConfig;
  /** Gateway filter applied to the test (single target path), persisted for display in `view ab-test`. */
  gatewayFilter?: GatewayFilter;
  maxDurationExpiresAt?: string;
  /** Per-evaluator comparison metrics, populated by refresh(). */
  results?: ABTestResults;
  failureReason?: string;
}

// ============================================================================
// Insights (failure analysis) types
// ============================================================================

export interface InsightRelatedSession {
  sessionId?: string;
  recommendationType?: string;
}

export interface InsightRootCause {
  rootCauseCategory?: string;
  rootCauseDescription?: string;
  recommendation?: string;
  relatedSessions?: InsightRelatedSession[];
}

export interface InsightFailureCategory {
  failureCategoryName?: string;
  failureCategoryDescription?: string;
  categoryGroupName?: string;
  rootCauses?: InsightRootCause[];
}

export interface FailureAnalysisResult {
  failureCategories?: InsightFailureCategory[];
}

export interface InsightsJobRecord extends JobRecordBase {
  type: 'insights';
  name: string;
  /** Insight types requested. */
  insights: string[];
  /** Optional evaluators (needed for recommendation chaining). */
  evaluators?: string[];
  /** Server-computed evaluation results. */
  evaluationResults?: EvaluationResults;
  /** Structured failure analysis results from GetBatchEvaluation. */
  failureAnalysisResult?: FailureAnalysisResult;
}

export type JobRecord = RecommendationJobRecord | BatchEvaluationJobRecord | ABTestJobRecord | InsightsJobRecord;

// ============================================================================
// Start options (engine-facing; non-colliding with the AWS-layer Start* types)
// ============================================================================

export interface StartRecommendationJobOptions {
  type: RecommendationType;
  agent?: string;
  /** Evaluator name(s), Builtin.* ids, or ARNs (exactly one for system-prompt; none for tool-description). */
  evaluators: string[];
  inputSource: RecommendationInputSource;
  bundleName?: string;
  bundleVersion?: string;
  systemPromptJsonPath?: string;
  toolDescJsonPaths?: ToolDescJsonPath[];
  inlineContent?: string;
  promptFile?: string;
  tools?: string[];
  traceSource: RecommendationTraceSource;
  lookbackDays?: number;
  sessionIds?: string[];
  spansFile?: string;
  /** Use a local insights run as trace source (resolves batchEvaluationArn from .cli/jobs/insights/) */
  fromInsights?: string;
  /** Use a batch evaluation ARN directly as trace source */
  batchEvaluationArn?: string;
  region?: string;
  /** Optional recommendation name. */
  recommendationName?: string;
  /** KMS key ARN for encrypting recommendation results. */
  kmsKeyArn?: string;
  /** Progress for the slow pre-start span fetch (sessions/spans-file). */
  onProgress?: (status: string, message: string) => void;
}

export interface StartBatchEvaluationJobOptions {
  agent: string;
  /** Evaluator name(s) / Builtin.* ids (resolved to short ids in create()). */
  evaluators: string[];
  name?: string;
  region?: string;
  /** Sessions to evaluate (caller resolves these from a dataset Phase-1 run when applicable). */
  sessionIds?: string[];
  /** Lookback window (used only when no sessionIds are given). */
  lookbackDays?: number;
  /** Ground-truth metadata (explicit or dataset-derived; caller supplies). */
  sessionMetadata?: SessionMetadataEntry[];
  /** Runtime endpoint name (e.g. PROMPT_V1). */
  endpoint?: string;
  /** Recorded on the job for display; the engine does NOT run dataset Phase-1 (caller does). */
  source?: BatchEvaluationSource;
  dataset?: { id: string; version: string };
  /** KMS key ARN for encrypting batch evaluation results. */
  kmsKeyArn?: string;
  onProgress?: (status: string, message: string) => void;
}

export interface StartABTestJobOptions {
  name: string;
  mode: ABTestMode;
  description?: string;
  /** Gateway NAME — resolved to an ARN in create() against deployed state (must pre-exist). */
  gateway: string;
  /** Config-bundle mode: the runtime being tested (also used as the record's `agent`). */
  agent?: string;
  // ── config-bundle mode ──
  controlBundle?: string;
  controlVersion?: string;
  treatmentBundle?: string;
  treatmentVersion?: string;
  /** Single online-eval config name/ARN (applies to both variants). */
  onlineEval?: string;
  // ── target-based mode ──
  runtime?: string;
  controlTarget?: string;
  treatmentTarget?: string;
  controlOnlineEval?: string;
  treatmentOnlineEval?: string;
  gatewayFilter?: string;
  // ── shared ──
  controlWeight: number;
  treatmentWeight: number;
  enableOnCreate?: boolean;
  region?: string;
  /** Optional role ARN override; auto-created in create() when omitted. */
  roleArn?: string;
  onProgress?: (status: string, message: string) => void;
}

export interface StartInsightsJobOptions {
  agent?: string;
  insights: string[];
  evaluators?: string[];
  onlineEvalConfigArn?: string;
  lookbackDays?: number;
  startTime?: string;
  endTime?: string;
  sessionIds?: string[];
  name?: string;
  region?: string;
  endpoint?: string;
  onProgress?: (status: string, message: string) => void;
}

export interface ListOptions {
  type?: JobType;
  limit?: number;
  agent?: string;
}

// ============================================================================
// Traits — small focused capabilities composed per job type
// ============================================================================

/** Create the job on the service and return the initial record. configIO is injected ONLY here. */
export interface Startable<O, J extends JobRecord> {
  create(opts: O, configIO: ConfigIO): Promise<Result<{ record: J }>>;
}

/** Fetch latest state from the service. Returns Result so the engine handles retries/error-persist. */
export interface Refreshable<J extends JobRecord> {
  refresh(record: J): Promise<Result<{ record: J }>>;
}

/** Stop a running job. */
export interface Stoppable<J extends JobRecord> {
  stop(record: J): Promise<Result>;
}

/** Delete the job from the service. */
export interface Archivable<J extends JobRecord> {
  archive(record: J): Promise<Result>;
}

/**
 * Optional per-type "settle" step the engine runs SEQUENTIALLY after a record first
 * reaches a terminal status — separate from the parallel refresh() because it may mutate
 * project config (and therefore needs configIO and must not race). Only recommendation
 * composes this (apply-to-bundle sync).
 */
export interface Settles<J extends JobRecord> {
  settle(record: J, configIO: ConfigIO): Promise<J>;
}

/** Pause/resume a running job (AB test only). */
export interface Pausable<J extends JobRecord> {
  pause(record: J): Promise<Result<{ record: J }>>;
  resume(record: J): Promise<Result<{ record: J }>>;
}

/** Promote a job's result into project config (AB test only — stop + apply winning variant). */
export interface Promotable<J extends JobRecord> {
  promote(record: J, configIO: ConfigIO): Promise<Result<{ record: J }>>;
}

/** Structured result from a live health/debug check. */
export interface DebugCheckResult {
  label: string;
  status: 'pass' | 'fail' | 'warn';
  detail: string;
}

/** Run live diagnostic checks against the service (AB test: eval config, gateway, spans). */
export interface Debuggable<J extends JobRecord> {
  debug(record: J): Promise<Result<{ checks: DebugCheckResult[] }>>;
}

// ============================================================================
// Composed handlers + registries
// ============================================================================

export type RecommendationHandler = Startable<StartRecommendationJobOptions, RecommendationJobRecord> &
  Refreshable<RecommendationJobRecord> &
  Settles<RecommendationJobRecord> &
  Archivable<RecommendationJobRecord>;

export type BatchEvaluationHandler = Startable<StartBatchEvaluationJobOptions, BatchEvaluationJobRecord> &
  Refreshable<BatchEvaluationJobRecord> &
  Stoppable<BatchEvaluationJobRecord> &
  Archivable<BatchEvaluationJobRecord>;

export type ABTestHandler = Startable<StartABTestJobOptions, ABTestJobRecord> &
  Refreshable<ABTestJobRecord> &
  Stoppable<ABTestJobRecord> &
  Pausable<ABTestJobRecord> &
  Promotable<ABTestJobRecord> &
  Debuggable<ABTestJobRecord> &
  Archivable<ABTestJobRecord>;

export type InsightsHandler = Startable<StartInsightsJobOptions, InsightsJobRecord> &
  Refreshable<InsightsJobRecord> &
  Archivable<InsightsJobRecord>;

export interface RecordByType {
  recommendation: RecommendationJobRecord;
  'batch-evaluation': BatchEvaluationJobRecord;
  'ab-test': ABTestJobRecord;
  insights: InsightsJobRecord;
}

export interface StartOptionsByType {
  recommendation: StartRecommendationJobOptions;
  'batch-evaluation': StartBatchEvaluationJobOptions;
  'ab-test': StartABTestJobOptions;
  insights: StartInsightsJobOptions;
}

export interface HandlerByType {
  recommendation: RecommendationHandler;
  'batch-evaluation': BatchEvaluationHandler;
  'ab-test': ABTestHandler;
  insights: InsightsHandler;
}

/** Job types whose handler composes a given trait — derived so they track trait composition automatically. */
export type StoppableJobType = {
  [K in JobType]: HandlerByType[K] extends Stoppable<RecordByType[K]> ? K : never;
}[JobType];

export type PausableJobType = {
  [K in JobType]: HandlerByType[K] extends Pausable<RecordByType[K]> ? K : never;
}[JobType];

export type PromotableJobType = {
  [K in JobType]: HandlerByType[K] extends Promotable<RecordByType[K]> ? K : never;
}[JobType];

export type DebuggableJobType = {
  [K in JobType]: HandlerByType[K] extends Debuggable<RecordByType[K]> ? K : never;
}[JobType];

// ============================================================================
// Engine
// ============================================================================

/** Runtime capability flags for TUI affordances (display only — legality is enforced by types). */
export interface JobCapabilities {
  canStop: boolean;
  canPause: boolean;
  canPromote: boolean;
  canDebug: boolean;
}

export interface JobEngine {
  /** Resolve + ONE API call + save. configIO is read only here. */
  start<T extends JobType>(type: T, opts: StartOptionsByType[T]): Promise<Result<{ record: RecordByType[T] }>>;
  /** Read one record; refresh (+ settle) if non-terminal. */
  get<T extends JobType>(type: T, id: string): Promise<RecordByType[T] | undefined>;
  /** List records of one type; refresh non-terminal in parallel, settle sequentially. */
  list<T extends JobType>(opts: ListOptions & { type: T }): Promise<RecordByType[T][]>;
  /** List across all types (union return). */
  list(opts?: ListOptions): Promise<JobRecord[]>;
  /** Stop a running job — only stoppable types accepted (compile-time narrowed). */
  stop(type: StoppableJobType, id: string): Promise<Result>;
  /** Pause a running job — only pausable types accepted (compile-time narrowed). */
  pause(type: PausableJobType, id: string): Promise<Result>;
  /** Resume a paused job — only pausable types accepted (compile-time narrowed). */
  resume(type: PausableJobType, id: string): Promise<Result>;
  /** Promote a job's result into project config — only promotable types accepted (compile-time narrowed). */
  promote(type: PromotableJobType, id: string): Promise<Result>;
  /** Delete from the service + remove the local file. */
  archive(type: JobType, id: string): Promise<Result>;
  /** Run live diagnostic checks — only debuggable types accepted (compile-time narrowed). */
  debug(type: DebuggableJobType, id: string): Promise<Result<{ checks: DebugCheckResult[] }>>;
  /** Display-only capability flags for the TUI. */
  capabilities(type: JobType): JobCapabilities;
}
