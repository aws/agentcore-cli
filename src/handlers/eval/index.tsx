import { Router } from "../../router";
import { renderTui } from "../../tui";
import { withTuiOnEmptyFlagsAndArgs } from "../../middleware";
import type { AppIO } from "../../io";
import type { Core } from "../types";
import { createEvaluatorHandler } from "./evaluator";
import { createOnlineEvalHandler } from "./online-eval";
import { createOnlineInsightHandler } from "./online-insight";
import { createDatasetHandler } from "./dataset";
import { createBatchEvaluationHandler } from "./batch-evaluation";
import { createBatchInsightsHandler } from "./batch-insights";
import { createOnDemandHandler } from "./ondemand";
import { createConfigBundleHandler } from "./config-bundle";
import { createAbTestHandler } from "./ab-test";
import { createRecommendationHandler } from "./recommendation";

export function createEvalHandler(core: Core, io: AppIO): Router {
  return new Router("eval", "evaluate and optimize AgentCore agents")
    .use(withTuiOnEmptyFlagsAndArgs(core, io))
    .default(renderTui(core, io))
    .handler(createEvaluatorHandler(core, io))
    .handler(createOnlineEvalHandler(core, io))
    .handler(createOnlineInsightHandler(core, io))
    .handler(createDatasetHandler(core, io))
    .handler(createBatchEvaluationHandler(core, io))
    .handler(createBatchInsightsHandler(core, io))
    .handler(createOnDemandHandler(core, io))
    .handler(createConfigBundleHandler(core, io))
    .handler(createAbTestHandler(core, io))
    .handler(createRecommendationHandler(core, io));
}

export { EvalScreen } from "./screen.tsx";
