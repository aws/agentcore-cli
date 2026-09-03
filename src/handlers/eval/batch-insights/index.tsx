import type { AppIO } from "../../../io";
import { Router } from "../../../router";
import { withTuiOnEmptyFlagsAndArgs } from "../../../middleware";
import { renderTui } from "../../../tui";
import type { Core } from "../../types";
import { createGetBatchInsightsHandler } from "./get";
import { createListBatchInsightsHandler } from "./list";
import { createRunBatchInsightsHandler } from "./run";

export function createBatchInsightsHandler(core: Core, io: AppIO): Router {
  return new Router("batch-insights", "run and inspect AgentCore batch insights")
    .use(withTuiOnEmptyFlagsAndArgs(core, io))
    .default(renderTui(core, io))
    .supportedTuiCommands("get", "list")
    .handler(createRunBatchInsightsHandler(core, io))
    .handler(createGetBatchInsightsHandler(core))
    .handler(createListBatchInsightsHandler(core));
}

export { BatchInsightsScreen } from "./screen.tsx";
