import { Router } from "../../../router";
import type { AppIO, Core } from "../../types";
import { createHelpDefault } from "../../help";
import { createLlmAsAJudgeCreateHandler, createLlmAsAJudgeUpdateHandler } from "./llm-as-a-judge";
import { createCodeBasedCreateHandler, createCodeBasedUpdateHandler } from "./code-based";
import { createGetEvaluatorHandler } from "./get";
import { createListEvaluatorsHandler } from "./list";
import { createDeleteEvaluatorHandler } from "./delete";

export function createEvaluatorHandler(core: Core, io: AppIO): Router {
  const llmAsAJudge = new Router("llm-as-a-judge", "manage LLM-as-a-Judge evaluators")
    .default(createHelpDefault(io))
    .handler(createLlmAsAJudgeCreateHandler(core, io))
    .handler(createLlmAsAJudgeUpdateHandler(core, io));

  const codeBased = new Router("code-based", "manage code-based (Lambda-backed) evaluators")
    .default(createHelpDefault(io))
    .handler(createCodeBasedCreateHandler(core, io))
    .handler(createCodeBasedUpdateHandler(core));

  return new Router("evaluator", "manage AgentCore evaluators")
    .default(createHelpDefault(io))
    .handler(llmAsAJudge)
    .handler(codeBased)
    .handler(createGetEvaluatorHandler(core))
    .handler(createListEvaluatorsHandler(core))
    .handler(createDeleteEvaluatorHandler(core));
}
