import { Router } from "../../router";
import { renderTui } from "../../tui";
import { withTuiOnEmptyFlagsAndArgs } from "../../middleware";
import type { AppIO } from "../../io";
import type { Core } from "../types";
import { createEvaluatorHandler } from "./evaluator";
import { createOnlineEvalHandler } from "./online-eval";
import { createDatasetHandler } from "./dataset";
import { createBatchEvaluationHandler } from "./batch-evaluation";
import { createOnDemandHandler } from "./ondemand";

export function createEvalHandler(core: Core, io: AppIO): Router {
  return new Router("eval", "evaluate and optimize AgentCore agents")
    .use(withTuiOnEmptyFlagsAndArgs(core, io))
    .default(renderTui(core, io))
    .handler(createEvaluatorHandler(core, io))
    .handler(createOnlineEvalHandler(core, io))
    .handler(createDatasetHandler(core, io))
    .handler(createBatchEvaluationHandler(core, io))
    .handler(createOnDemandHandler(core, io));
}

export { EvalScreen } from "./screen.tsx";
