import type { AppIO } from "../../../io";
import { Router } from "../../../router";
import { createHelpDefault } from "../../help";
import type { Core } from "../../types";
import { createGetBatchInsightsHandler } from "./get";
import { createListBatchInsightsHandler } from "./list";
import { createRunBatchInsightsHandler } from "./run";

export function createBatchInsightsHandler(core: Core, io: AppIO): Router {
  return new Router("batch-insights", "run and inspect batch insights")
    .default(createHelpDefault(io))
    .handler(createRunBatchInsightsHandler(core, io))
    .handler(createGetBatchInsightsHandler(core))
    .handler(createListBatchInsightsHandler(core));
}
