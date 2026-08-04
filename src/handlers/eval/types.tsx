import type {
  CreateDatasetRequest,
  CreateDatasetResponse,
  CreateEvaluatorRequest,
  CreateEvaluatorResponse,
  CreateOnlineEvaluationConfigResponse,
  DeleteDatasetResponse,
  DeleteEvaluatorResponse,
  DeleteOnlineEvaluationConfigResponse,
  GetDatasetResponse,
  GetEvaluatorResponse,
  GetOnlineEvaluationConfigResponse,
  ListDatasetsResponse,
  ListEvaluatorsResponse,
  ListOnlineEvaluationConfigsResponse,
  DataSourceConfig,
  RatingScale,
  Rule,
  UpdateEvaluatorResponse,
  UpdateOnlineEvaluationConfigResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import type { CoreOptions } from "../../core/types";

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
  clientToken?: string;
};

// CodeBasedUpdate carries the fields a caller may change on a code-based
// evaluator. Undefined fields are preserved from the existing evaluator, for the
// same union-replacement reason described on LlmAsAJudgeUpdate.
export type CodeBasedUpdate = {
  lambdaArn?: string;
  timeout?: number;
  kmsKeyArn?: string;
  clientToken?: string;
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
}
