import { Router } from "../../../router";
import type { AppIO } from "../../../io";
import type { Core } from "../../types";
import { createHelpDefault } from "../../help";
import { createListInsightsHandler } from "./list";
import { createGetInsightHandler } from "./get";
import { createUpdateInsightHandler } from "./update";

// The service generates Insights, so there is no create or delete. No TUI screen
// yet, so a bare invocation prints help.
export function createInsightHandler(core: Core, io: AppIO): Router {
  return new Router("insight", "read and archive AgentCore Agent Insights")
    .default(createHelpDefault(io))
    .handler(createListInsightsHandler(core))
    .handler(createGetInsightHandler(core))
    .handler(createUpdateInsightHandler(core));
}
