import {
  CreateEvaluatorCommand,
  DeleteEvaluatorCommand,
  GetEvaluatorCommand,
  ListEvaluatorsCommand,
  UpdateEvaluatorCommand,
  type CreateEvaluatorRequest,
  type CreateEvaluatorResponse,
  type DeleteEvaluatorResponse,
  type EvaluatorConfig,
  type GetEvaluatorResponse,
  type ListEvaluatorsResponse,
  type UpdateEvaluatorResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import type { CodeBasedUpdate, CoreEvalClient, LlmAsAJudgeUpdate } from "../handlers/eval/types";
import type { AwsClients, CoreOptions } from "./types";
import { toClientConfig } from "./utils";

export class EvalClient implements CoreEvalClient {
  constructor(private readonly clients: AwsClients) {}

  async createEvaluator(
    request: CreateEvaluatorRequest,
    options: CoreOptions,
  ): Promise<CreateEvaluatorResponse> {
    return this.clients.control(toClientConfig(options)).send(new CreateEvaluatorCommand(request));
  }

  // updateLlmAsAJudgeEvaluator rebuilds the full llmAsAJudge config from the
  // current evaluator, overlays the provided fields, and sends it. UpdateEvaluator
  // replaces the entire evaluatorConfig union, and the llmAsAJudge arm requires
  // instructions + ratingScale + modelConfig together, so a partial update would
  // otherwise drop the fields the caller didn't pass.
  async updateLlmAsAJudgeEvaluator(
    id: string,
    update: LlmAsAJudgeUpdate,
    options: CoreOptions,
  ): Promise<UpdateEvaluatorResponse> {
    const control = this.clients.control(toClientConfig(options));
    const current = await control.send(new GetEvaluatorCommand({ evaluatorId: id }));
    const existing =
      current.evaluatorConfig && "llmAsAJudge" in current.evaluatorConfig
        ? current.evaluatorConfig.llmAsAJudge
        : undefined;

    const instructions = update.instructions ?? existing?.instructions;
    const ratingScale = update.ratingScale ?? existing?.ratingScale;
    const modelId =
      update.model ??
      (existing?.modelConfig && "bedrockEvaluatorModelConfig" in existing.modelConfig
        ? existing.modelConfig.bedrockEvaluatorModelConfig?.modelId
        : undefined);

    if (!instructions || !ratingScale || !modelId) {
      throw new TypeError(
        `Evaluator "${id}" is not an LLM-as-a-Judge evaluator or is missing configuration required to update it`,
      );
    }

    const evaluatorConfig: EvaluatorConfig = {
      llmAsAJudge: {
        instructions,
        ratingScale,
        modelConfig: { bedrockEvaluatorModelConfig: { modelId } },
      },
    };

    return control.send(
      new UpdateEvaluatorCommand({
        evaluatorId: id,
        evaluatorConfig,
        kmsKeyArn: update.kmsKeyArn,
        clientToken: update.clientToken,
      }),
    );
  }

  // updateCodeBasedEvaluator mirrors updateLlmAsAJudgeEvaluator: it merges the
  // provided lambda ARN / timeout over the current codeBased config so unset
  // fields are preserved across the union-replacing UpdateEvaluator call.
  async updateCodeBasedEvaluator(
    id: string,
    update: CodeBasedUpdate,
    options: CoreOptions,
  ): Promise<UpdateEvaluatorResponse> {
    const control = this.clients.control(toClientConfig(options));
    const current = await control.send(new GetEvaluatorCommand({ evaluatorId: id }));
    const existing =
      current.evaluatorConfig && "codeBased" in current.evaluatorConfig
        ? current.evaluatorConfig.codeBased
        : undefined;
    const existingLambda =
      existing && "lambdaConfig" in existing ? existing.lambdaConfig : undefined;

    const lambdaArn = update.lambdaArn ?? existingLambda?.lambdaArn;
    if (!lambdaArn) {
      throw new TypeError(
        `Evaluator "${id}" is not a code-based evaluator or is missing configuration required to update it`,
      );
    }
    const lambdaTimeoutInSeconds = update.timeout ?? existingLambda?.lambdaTimeoutInSeconds;

    const evaluatorConfig: EvaluatorConfig = {
      codeBased: { lambdaConfig: { lambdaArn, lambdaTimeoutInSeconds } },
    };

    return control.send(
      new UpdateEvaluatorCommand({
        evaluatorId: id,
        evaluatorConfig,
        kmsKeyArn: update.kmsKeyArn,
        clientToken: update.clientToken,
      }),
    );
  }

  async getEvaluator(id: string, options: CoreOptions): Promise<GetEvaluatorResponse> {
    return this.clients
      .control(toClientConfig(options))
      .send(new GetEvaluatorCommand({ evaluatorId: id }));
  }

  async listEvaluators(
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListEvaluatorsResponse> {
    return this.clients
      .control(toClientConfig(options))
      .send(new ListEvaluatorsCommand({ nextToken, maxResults }));
  }

  async deleteEvaluator(id: string, options: CoreOptions): Promise<DeleteEvaluatorResponse> {
    return this.clients
      .control(toClientConfig(options))
      .send(new DeleteEvaluatorCommand({ evaluatorId: id }));
  }
}
