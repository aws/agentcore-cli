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
import { InputValidationError } from "../errors";
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

    // Reject a type mismatch before merging: UpdateEvaluator replaces the whole
    // evaluatorConfig union, so merging into the wrong arm would silently convert
    // a code-based evaluator into an LLM-as-a-Judge one.
    if (!current.evaluatorConfig || !("llmAsAJudge" in current.evaluatorConfig)) {
      throw new InputValidationError(`Evaluator "${id}" is not an LLM-as-a-Judge evaluator`, {
        meta: { evaluatorId: id },
      });
    }
    const existing = current.evaluatorConfig.llmAsAJudge;

    const instructions = update.instructions ?? existing?.instructions;
    const ratingScale = update.ratingScale ?? existing?.ratingScale;
    // Preserve the existing Bedrock model config (inferenceConfig,
    // additionalModelRequestFields, ...) and override only the model id, so an
    // update that touches other fields does not drop model tuning.
    const existingModel =
      existing?.modelConfig && "bedrockEvaluatorModelConfig" in existing.modelConfig
        ? existing.modelConfig.bedrockEvaluatorModelConfig
        : undefined;
    const modelId = update.model ?? existingModel?.modelId;

    if (!instructions || !ratingScale || !modelId) {
      throw new InputValidationError(
        `Evaluator "${id}" is missing configuration required to update it: ` +
          `instructions, rating scale, and model are all required`,
        { meta: { evaluatorId: id } },
      );
    }

    const evaluatorConfig: EvaluatorConfig = {
      llmAsAJudge: {
        instructions,
        ratingScale,
        modelConfig: { bedrockEvaluatorModelConfig: { ...existingModel, modelId } },
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

    // Same union-replacement hazard as updateLlmAsAJudgeEvaluator: reject a type
    // mismatch instead of converting the evaluator to code-based.
    if (!current.evaluatorConfig || !("codeBased" in current.evaluatorConfig)) {
      throw new InputValidationError(`Evaluator "${id}" is not a code-based evaluator`, {
        meta: { evaluatorId: id },
      });
    }
    const existing = current.evaluatorConfig.codeBased;
    const existingLambda =
      existing && "lambdaConfig" in existing ? existing.lambdaConfig : undefined;

    const lambdaArn = update.lambdaArn ?? existingLambda?.lambdaArn;
    if (!lambdaArn) {
      throw new InputValidationError(
        `Evaluator "${id}" is missing configuration required to update it: a Lambda ARN is required`,
        { meta: { evaluatorId: id } },
      );
    }
    const lambdaTimeoutInSeconds = update.timeout ?? existingLambda?.lambdaTimeoutInSeconds;

    const evaluatorConfig: EvaluatorConfig = {
      codeBased: { lambdaConfig: { ...existingLambda, lambdaArn, lambdaTimeoutInSeconds } },
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
