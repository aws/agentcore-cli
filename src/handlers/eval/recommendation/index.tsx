import type { AppIO } from "../../../io";
import { Router } from "../../../router";
import type { Core } from "../../types";
import { createDeleteRecommendationHandler } from "./delete";
import { createGetRecommendationHandler } from "./get";
import { createListRecommendationsHandler } from "./list";
import { createStartRecommendationHandler } from "./start";

export function createRecommendationHandler(core: Core, io: AppIO): Router {
  return new Router("recommendation", "manage AgentCore recommendations")
    .supportedTuiCommands()
    .handler(createStartRecommendationHandler(core, io))
    .handler(createGetRecommendationHandler(core))
    .handler(createListRecommendationsHandler(core))
    .handler(createDeleteRecommendationHandler(core));
}
