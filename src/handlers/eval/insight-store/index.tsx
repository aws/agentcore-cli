import { Router } from "../../../router";
import type { AppIO } from "../../../io";
import type { Core } from "../../types";
import { createHelpDefault } from "../../help";
import { createListInsightStoresHandler } from "./list";
import { createGetInsightStoreHandler } from "./get";
import { createUpdateInsightStoreHandler } from "./update";

// The service creates the Store, so there is no create or delete. No TUI screen
// yet, so a bare invocation prints help.
export function createInsightStoreHandler(core: Core, io: AppIO): Router {
  return new Router("insight-store", "manage the AgentCore Agent Insight Store")
    .default(createHelpDefault(io))
    .handler(createListInsightStoresHandler(core))
    .handler(createGetInsightStoreHandler(core))
    .handler(createUpdateInsightStoreHandler(core));
}
