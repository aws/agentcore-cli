import { Router } from "../../../router";
import { renderTui } from "../../../tui";
import { withTuiOnEmptyFlagsAndArgs } from "../../../middleware";
import type { AppIO } from "../../../io";
import type { Core } from "../../types";
import { createLlmAsAJudgeHandler } from "./llm-as-a-judge";
import { createCodeBasedHandler } from "./code-based";
import { createGetEvaluatorHandler } from "./get";
import { createListEvaluatorsHandler } from "./list";
import { createDeleteEvaluatorHandler } from "./delete";

export function createEvaluatorHandler(core: Core, io: AppIO): Router {
  return new Router("evaluator", "manage AgentCore evaluators")
    .use(withTuiOnEmptyFlagsAndArgs(core, io))
    .default(renderTui(core, io))
    .handler(createLlmAsAJudgeHandler(core, io))
    .handler(createCodeBasedHandler(core, io))
    .handler(createGetEvaluatorHandler(core))
    .handler(createListEvaluatorsHandler(core))
    .handler(createDeleteEvaluatorHandler(core));
}

export { EvaluatorScreen } from "./screen.tsx";
