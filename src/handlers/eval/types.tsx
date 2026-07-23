import type {
  CreateEvaluatorRequest,
  CreateEvaluatorResponse,
  DeleteEvaluatorResponse,
  GetEvaluatorResponse,
  ListEvaluatorsResponse,
  RatingScale,
  UpdateEvaluatorResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import type { CoreOptions } from "../../core/types";

// LlmAsAJudgeUpdate carries the fields a caller may change on an LLM-as-a-Judge
// evaluator. Any field left undefined is preserved from the existing evaluator:
// the AgentCore UpdateEvaluator API replaces the whole evaluatorConfig union, and
// the llmAsAJudge arm requires instructions + ratingScale + modelConfig together,
// so a partial update is only possible by merging over the current definition.
export interface LlmAsAJudgeUpdate {
  instructions?: string;
  model?: string;
  ratingScale?: RatingScale;
  kmsKeyArn?: string;
  clientToken?: string;
}

// CodeBasedUpdate carries the fields a caller may change on a code-based
// evaluator. Undefined fields are preserved from the existing evaluator, for the
// same union-replacement reason described on LlmAsAJudgeUpdate.
export interface CodeBasedUpdate {
  lambdaArn?: string;
  timeout?: number;
  kmsKeyArn?: string;
  clientToken?: string;
}

// CoreEvalClient is the evaluator surface the eval handlers depend on. It is
// declared here, next to the handlers that consume it, and implemented by
// src/core/eval.tsx (dependency inversion: handlers own the abstraction).
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
}
