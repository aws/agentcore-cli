import type {
  CreateEvaluatorRequest,
  CreateEvaluatorResponse,
  CreateOnlineEvaluationConfigResponse,
  DeleteEvaluatorResponse,
  DeleteOnlineEvaluationConfigResponse,
  GetEvaluatorResponse,
  GetOnlineEvaluationConfigResponse,
  ListEvaluatorsResponse,
  ListOnlineEvaluationConfigsResponse,
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
// runtime by Core — or by raw log groups/service names directly. The execution
// role is optional: when omitted, Core provisions a default one scoped to the
// resolved log group.
//
// The CreateOnlineEvaluationConfig API has no kmsKeyArn field of its own (KMS
// only matters here as a permission the execution role needs when the selected
// evaluators are themselves KMS-encrypted), so `--kms-key-arn` on this command
// is intentionally not modeled — it doesn't exist on the underlying request.
export type CreateOnlineEvalInput = {
  name: string;
  description?: string;
  samplingRate: number;
  sessionTimeoutMinutes?: number;
  filters?: Rule["filters"];
  evaluatorIds?: string[];
  evaluationExecutionRoleArn?: string;
  enableOnCreate?: boolean;
  clientToken?: string;
} & (
  | { agent: string; endpoint?: string; logGroupNames?: undefined; serviceNames?: undefined }
  | { agent?: undefined; endpoint?: undefined; logGroupNames: string[]; serviceNames: string[] }
);

// UpdateOnlineEvalInput carries the fields a caller may change on an online
// evaluation config. Undefined fields are left untouched by Core (merged over
// the current config, since UpdateOnlineEvaluationConfig replaces the whole
// `rule` object); `clearEndpoint` nulls out the endpoint scope, falling back to
// the runtime's default log group. See CreateOnlineEvalInput on why there is no
// kmsKeyArn field.
export type UpdateOnlineEvalInput = {
  samplingRate?: number;
  sessionTimeoutMinutes?: number;
  filters?: Rule["filters"];
  evaluatorIds?: string[];
  endpoint?: string;
  clearEndpoint?: boolean;
  clientToken?: string;
};

// CoreEvalClient is the surface the `eval` handlers depend on, covering both
// evaluators and online evaluation configs. It is declared here, next to the
// handlers that consume it, and implemented by src/core/eval.tsx (dependency
// inversion: handlers own the abstraction).
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
  updateOnlineEvaluationConfig(
    id: string,
    update: UpdateOnlineEvalInput,
    options: CoreOptions,
  ): Promise<UpdateOnlineEvaluationConfigResponse>;
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
}
