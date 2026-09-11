import type { AppIO } from "../../../io";
import { Router } from "../../../router";
import { renderTui } from "../../../tui";
import { withTuiOnEmptyFlagsAndArgs } from "../../../middleware";
import type { Core } from "../../types";
import { createDeleteRecommendationHandler } from "./delete";
import { createGetRecommendationHandler } from "./get";
import { createListRecommendationsHandler } from "./list";
import { createStartRecommendationHandler } from "./start";

// A bare invocation opens the interactive TUI (list → get), matching
// batch-evaluation; start/delete stay below the command-line-only divider.
export function createRecommendationHandler(core: Core, io: AppIO): Router {
  return new Router("recommendation", "manage AgentCore recommendations")
    .use(withTuiOnEmptyFlagsAndArgs(core, io))
    .default(renderTui(core, io))
    .supportedTuiCommands("get", "list")
    .handler(createStartRecommendationHandler(core, io))
    .handler(createGetRecommendationHandler(core))
    .handler(createListRecommendationsHandler(core))
    .handler(createDeleteRecommendationHandler(core));
}

export { RecommendationScreen } from "./screen.tsx";
