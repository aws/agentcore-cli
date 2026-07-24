import { Router } from "../../../router";
import type { AppIO, Core } from "../../types";
import { createHelpDefault } from "../../help";
import { createLlmAsAJudgeHandler } from "./llm-as-a-judge";
import { createCodeBasedHandler } from "./code-based";
import { createGetEvaluatorHandler } from "./get";
import { createListEvaluatorsHandler } from "./list";
import { createDeleteEvaluatorHandler } from "./delete";

export function createEvaluatorHandler(core: Core, io: AppIO): Router {
  return new Router("evaluator", "manage AgentCore evaluators")
    .default(createHelpDefault(io))
    .handler(createLlmAsAJudgeHandler(core, io))
    .handler(createCodeBasedHandler(core, io))
    .handler(createGetEvaluatorHandler(core))
    .handler(createListEvaluatorsHandler(core))
    .handler(createDeleteEvaluatorHandler(core));
}
