import { Router } from "../../../router";
import type { AppIO } from "../../../io";
import type { Core } from "../../types";
import { createCreateOnlineInsightHandler } from "./create";
import { createGetOnlineInsightHandler } from "./get";
import { createListOnlineInsightHandler } from "./list";
import { createPauseOnlineInsightHandler } from "./pause";
import { createResumeOnlineInsightHandler } from "./resume";
import { createDeleteOnlineInsightHandler } from "./delete";

export function createOnlineInsightHandler(core: Core, io: AppIO): Router {
  return new Router("online-insight", "manage AgentCore online insight configs")
    .supportedTuiCommands()
    .handler(createCreateOnlineInsightHandler(core, io))
    .handler(createGetOnlineInsightHandler(core))
    .handler(createListOnlineInsightHandler(core))
    .handler(createPauseOnlineInsightHandler(core))
    .handler(createResumeOnlineInsightHandler(core))
    .handler(createDeleteOnlineInsightHandler(core));
}
