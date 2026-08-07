import type {
  CreateConfigurationBundleRequest,
  CreateConfigurationBundleResponse,
  CreateDatasetRequest,
  CreateDatasetResponse,
  CreateDatasetVersionResponse,
  CreateEvaluatorRequest,
  CreateEvaluatorResponse,
  CreateOnlineEvaluationConfigResponse,
  DeleteConfigurationBundleResponse,
  DeleteDatasetResponse,
  DeleteEvaluatorResponse,
  DeleteOnlineEvaluationConfigResponse,
  GetConfigurationBundleResponse,
  GetConfigurationBundleVersionResponse,
  GetDatasetResponse,
  GetEvaluatorResponse,
  GetOnlineEvaluationConfigResponse,
  ListConfigurationBundlesResponse,
  ListConfigurationBundleVersionsResponse,
  ListDatasetsResponse,
  ListEvaluatorsResponse,
  ListOnlineEvaluationConfigsResponse,
  DataSourceConfig,
  RatingScale,
  Rule,
  UpdateConfigurationBundleRequest,
  UpdateConfigurationBundleResponse,
  UpdateEvaluatorResponse,
  UpdateOnlineEvaluationConfigResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import type {
  GetBatchEvaluationResponse,
  ListBatchEvaluationsResponse,
  StartBatchEvaluationResponse,
  SessionMetadataShape,
  DataSourceConfig as DataPlaneDataSourceConfig,
} from "@aws-sdk/client-bedrock-agentcore";
import type { CoreOptions } from "../../core/types";

// SessionWindow is the resolved explicit time filter for a batch evaluation's
// session source (from --start-time/--end-time). Maps directly to the SDK's
// SessionFilterConfig.
export type SessionWindow = { startTime: Date; endTime: Date };

// SessionSourceValue is the resolved batch-evaluation session source. `origin`
// discriminates which dataSourceConfig arm Core builds; `window` is the shared
// time filter (absent means "all available sessions").
export type SessionSourceValue =
  // `agent` is a harness id or runtime id; Core resolves it to the runtime + log group.
  | {
      origin: "agent";
      agent: string;
      endpoint?: string;
      window?: SessionWindow;
      sessionIds?: string[];
    }
  | { origin: "online-eval"; onlineEvaluationConfigId: string; window?: SessionWindow }
  // Raw escape hatch: a full DataSourceConfig supplied via --data-source-config,
  // already parsed from JSON. Passed through to the API untouched.
  | { origin: "raw"; dataSourceConfig: DataPlaneDataSourceConfig };

// BatchEvaluationResultEntry is one per-session/-trace/-tool evaluation score,
// parsed from the CloudWatch output log stream a completed batch evaluation
// writes to. Unlike the old CLI's parser — which read only the evaluator name,
// score, label, and explanation and so flattened every level into an
// indistinguishable list — this keeps `level` and the id fields so callers can
// tell a SESSION result from a TRACE or TOOL_CALL one, and group by session.
export type BatchEvaluationResultEntry = {
  evaluatorId: string;
  // The scope the score applies to, read from the result log record's
  // `aws.bedrock_agentcore.evaluation_level` attribute (Title-case, e.g. "Trace"
  // / "Session"). The trustworthy discriminator — do not infer it from which id
  // fields are set, since a trace-level result can still carry a session id.
  level?: string;
  sessionId?: string;
  traceId?: string;
  spanId?: string;
  toolName?: string;
  score?: number;
  label?: string;
  explanation?: string;
  error?: string;
};

// BatchEvaluationDetail is a GetBatchEvaluation response augmented with the
// per-session results read from CloudWatch. `results` is present only when the
// job is terminal, the response carried a CloudWatch output config, and the
// caller did not pass --disable-cw-results. A CloudWatch read failure leaves
// `results` absent and is surfaced as a warning on stderr rather than embedded
// here, so the job status is never hidden and --json stdout stays clean.
export type BatchEvaluationDetail = GetBatchEvaluationResponse & {
  results?: BatchEvaluationResultEntry[];
};

// GetBatchEvaluationResult is what getBatchEvaluation returns: the detail plus an
// optional `resultsError`. Core surfaces a CloudWatch read failure here rather
// than throwing (which would hide the job status) or logging silently (Core has
// no stderr) — the handler warns on stderr, the TUI ignores it. `resultsError` is
// only ever set when results were requested and the CloudWatch read threw.
export type GetBatchEvaluationResult = {
  detail: BatchEvaluationDetail;
  resultsError?: unknown;
};

// LlmAsAJudgeUpdate carries the fields a caller may change on an LLM-as-a-Judge
// evaluator. Any field left undefined is preserved from the existing evaluator:
// the AgentCore UpdateEvaluator API replaces the whole evaluatorConfig union, and
// the llmAsAJudge arm requires instructions + ratingScale + modelConfig together,
// so a partial update is only possible by merging over the current definition.
export type LlmAsAJudgeUpdate = {
  instructions?: string;
  model?: string;
  ratingScale?: RatingScale;
  kmsKeyArn?: string;
};

// CodeBasedUpdate carries the fields a caller may change on a code-based
// evaluator. Undefined fields are preserved from the existing evaluator, for the
// same union-replacement reason described on LlmAsAJudgeUpdate.
export type CodeBasedUpdate = {
  lambdaArn?: string;
  timeout?: number;
  kmsKeyArn?: string;
};

// CreateOnlineEvalInput mirrors CreateOnlineEvaluationConfigRequest but lets the
// caller identify the traffic to sample either by an existing agent — a plain
// AgentCore Runtime ID or a Harness ID, both resolved to the same underlying
// runtime by Core — or by supplying the API's dataSourceConfig directly. The
// execution role is optional: when omitted, Core provisions a default one scoped
// to the resolved log groups.
export type CreateOnlineEvalInput = {
  name: string;
  description?: string;
  samplingRate: number;
  sessionTimeoutMinutes?: number;
  filters?: Rule["filters"];
  evaluatorIds?: string[];
  evaluationExecutionRoleArn?: string;
  enableOnCreate?: boolean;
} & (
  | { agent: string; endpoint?: string; dataSourceConfig?: undefined }
  | { agent?: undefined; endpoint?: undefined; dataSourceConfig: DataSourceConfig }
);

// UpdateOnlineEvalInput carries the fields a caller may change on an online
// evaluation config. Undefined fields are left untouched by Core (merged over
// the current config, since UpdateOnlineEvaluationConfig replaces the whole
// `rule` object); `clearEndpoint` nulls out the endpoint scope, falling back to
// the agent's default log group.
export type UpdateOnlineEvalInput = {
  samplingRate?: number;
  sessionTimeoutMinutes?: number;
  filters?: Rule["filters"];
  evaluatorIds?: string[];
  // Repoint the evaluation at different traces: `agent` re-derives the source
  // from that agent (optionally at `endpoint`), `dataSourceConfig` replaces it
  // outright, and `endpoint`/`clearEndpoint` alone re-scope the agent the config
  // was already built from.
  agent?: string;
  endpoint?: string;
  clearEndpoint?: boolean;
  dataSourceConfig?: DataSourceConfig;
  // Replaces the execution role. The CLI never edits the permissions of a role the
  // caller names here — it is theirs to manage.
  evaluationExecutionRoleArn?: string;
  // Whether to re-scope a CLI-provisioned role when the data source moves
  // (default true). Only meaningful for a managed role: the old policy grants
  // query access to the previous log groups only.
  updateRole?: boolean;
};

// RoleScopeWarning reports that an execution role was left scoped to log groups
// the config no longer samples, so the caller can surface it. Returned rather
// than logged from Core so the handler owns how it is presented.
export type RoleScopeWarning = {
  reason: "custom-role" | "update-declined" | "stale-scope";
  roleArn: string;
  logGroupNames: string[];
};

export type CreateDatasetInput = CreateDatasetRequest;
export type CreateConfigurationBundleInput = Pick<
  CreateConfigurationBundleRequest,
  "bundleName" | "components" | "kmsKeyArn"
>;
export type UpdateConfigurationBundleInput = Required<
  Pick<UpdateConfigurationBundleRequest, "components" | "commitMessage" | "branchName">
> &
  Pick<UpdateConfigurationBundleRequest, "kmsKeyArn">;

// StartBatchEvaluationInput is the CLI-facing shape for `batch-evaluation
// evaluate`. Core turns `source` into the API's dataSourceConfig union and
// `groundTruth` into evaluationMetadata.
export type StartBatchEvaluationInput = {
  name: string;
  description?: string;
  evaluatorIds: string[];
  source: SessionSourceValue;
  // Already-parsed --ground-truth (SessionMetadataShape[]) → evaluationMetadata.
  groundTruth?: SessionMetadataShape[];
  kmsKeyArn?: string;
};

// DatasetUpdateResult reports what reconciling a DRAFT against a local file
// changed. The counts are examples, not requests: each phase is batched to the
// service's per-request limit.
export type DatasetUpdateResult = {
  datasetId: string;
  added: number;
  updated: number;
  deleted: number;
  unchanged: number;
};

export type DatasetUpdateProgressEvent = {
  /** Human-readable description of the batch about to run. */
  message: string;
};

// CoreEvalClient is the evaluator, online evaluation, and dataset surface the eval
// handlers depend on. It is declared here, next to the handlers that consume it,
// and implemented by src/core/eval.tsx (dependency inversion: handlers own the
// abstraction).
export interface CoreEvalClient {
  createEvaluator(
    request: CreateEvaluatorRequest,
    options: CoreOptions,
  ): Promise<CreateEvaluatorResponse>;
  // update*Evaluator fetch the current evaluator and merge the provided fields
  // before sending, because the API replaces the entire evaluatorConfig union.
  updateLlmAsAJudgeEvaluator(
    id: string,
    update: LlmAsAJudgeUpdate,
    options: CoreOptions,
  ): Promise<UpdateEvaluatorResponse>;
  updateCodeBasedEvaluator(
    id: string,
    update: CodeBasedUpdate,
    options: CoreOptions,
  ): Promise<UpdateEvaluatorResponse>;
  getEvaluator(id: string, options: CoreOptions): Promise<GetEvaluatorResponse>;
  listEvaluators(
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListEvaluatorsResponse>;
  deleteEvaluator(id: string, options: CoreOptions): Promise<DeleteEvaluatorResponse>;

  // getBatchEvaluation returns the service-side job and, unless `includeResults`
  // is false, the per-session results read from its per-job CloudWatch stream once
  // terminal. A CloudWatch read failure is returned as `resultsError` (never
  // thrown) so the job status is never hidden.
  getBatchEvaluation(
    id: string,
    options: CoreOptions,
    opts?: { includeResults?: boolean },
  ): Promise<GetBatchEvaluationResult>;
  listBatchEvaluations(
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListBatchEvaluationsResponse>;
  // startBatchEvaluation submits an async, service-side evaluation over sessions
  // the service gathers from the resolved data source. Returns the durable job id
  // + RUNNING status; poll with getBatchEvaluation.
  startBatchEvaluation(
    input: StartBatchEvaluationInput,
    options: CoreOptions,
  ): Promise<StartBatchEvaluationResponse>;

  createOnlineEvaluationConfig(
    input: CreateOnlineEvalInput,
    options: CoreOptions,
  ): Promise<CreateOnlineEvaluationConfigResponse>;
  // Returns the service response plus an optional warning when the execution
  // role was left scoped to log groups the config no longer samples.
  updateOnlineEvaluationConfig(
    id: string,
    update: UpdateOnlineEvalInput,
    options: CoreOptions,
  ): Promise<{
    response: UpdateOnlineEvaluationConfigResponse;
    roleScopeWarning?: RoleScopeWarning;
  }>;
  getOnlineEvaluationConfig(
    id: string,
    options: CoreOptions,
  ): Promise<GetOnlineEvaluationConfigResponse>;
  listOnlineEvaluationConfigs(
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListOnlineEvaluationConfigsResponse>;
  setOnlineEvaluationExecutionStatus(
    id: string,
    executionStatus: "ENABLED" | "DISABLED",
    options: CoreOptions,
  ): Promise<UpdateOnlineEvaluationConfigResponse>;
  deleteOnlineEvaluationConfig(
    id: string,
    options: CoreOptions,
  ): Promise<DeleteOnlineEvaluationConfigResponse>;

  createConfigurationBundle(
    input: CreateConfigurationBundleInput,
    options: CoreOptions,
  ): Promise<CreateConfigurationBundleResponse>;
  // Omitting version returns the latest version on branchName; an explicit
  // version selects the immutable version API.
  getConfigurationBundle(
    id: string,
    version: string | undefined,
    branchName: string,
    options: CoreOptions,
  ): Promise<GetConfigurationBundleResponse | GetConfigurationBundleVersionResponse>;
  listConfigurationBundles(
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListConfigurationBundlesResponse>;
  // Updates are appended to the latest version on update.branchName.
  updateConfigurationBundle(
    id: string,
    update: UpdateConfigurationBundleInput,
    options: CoreOptions,
  ): Promise<UpdateConfigurationBundleResponse>;
  deleteConfigurationBundle(
    id: string,
    options: CoreOptions,
  ): Promise<DeleteConfigurationBundleResponse>;
  listConfigurationBundleVersions(
    id: string,
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListConfigurationBundleVersionsResponse>;

  // createDataset seeds a new dataset's DRAFT from `source`, which is required.
  // `schemaType` governs the structure of every example and is immutable after creation.
  // The response reports status CREATING — ingestion is asynchronous, and the dataset is not
  // writable until GetDataset reports ACTIVE.
  createDataset(input: CreateDatasetInput, options: CoreOptions): Promise<CreateDatasetResponse>;
  // getDataset returns metadata for one version
  getDataset(
    id: string,
    version: string | undefined,
    options: CoreOptions,
  ): Promise<GetDatasetResponse>;
  // downloadDataset writes one version's examples to `filePath` as JSONL
  downloadDataset(
    id: string,
    version: string | undefined,
    filePath: string,
    options: CoreOptions,
    signal?: AbortSignal,
  ): Promise<GetDatasetResponse>;
  listDatasets(
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListDatasetsResponse>;
  deleteDataset(
    id: string,
    version: string | undefined,
    options: CoreOptions,
  ): Promise<DeleteDatasetResponse>;
  // publishDataset freezes the current DRAFT as the next numbered version. The
  // DRAFT survives and stays editable, so publishing is additive
  publishDataset(id: string, options: CoreOptions): Promise<CreateDatasetVersionResponse>;
  // updateDatasetExamples reconciles the dataset's DRAFT with `filePath`, adding,
  // replacing, and removing examples so the DRAFT matches the file. Service-assigned
  // ids for added examples are written back to `filePath`, which the next update
  // needs to match those rows.
  updateDatasetExamples(
    id: string,
    filePath: string,
    options: CoreOptions,
    signal?: AbortSignal,
    // Called immediately before each mutation batch starts.
    onProgress?: (event: DatasetUpdateProgressEvent) => void,
  ): Promise<DatasetUpdateResult>;
}
