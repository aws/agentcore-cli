import { Router } from "../../../router";
import { renderTui } from "../../../tui";
import { withTuiOnEmptyFlagsAndArgs } from "../../../middleware";
import type { AppIO } from "../../../io";
import type { Core } from "../../types";
import { createCreateOnlineInsightHandler } from "./create";
import { createGetOnlineInsightHandler } from "./get";
import { createListOnlineInsightHandler } from "./list";
import { createUpdateOnlineInsightHandler } from "./update";
import { createPauseOnlineInsightHandler } from "./pause";
import { createResumeOnlineInsightHandler } from "./resume";
import { createDeleteOnlineInsightHandler } from "./delete";

export function createOnlineInsightHandler(core: Core, io: AppIO): Router {
  return new Router("online-insight", "manage AgentCore online insight configs")
    .use(withTuiOnEmptyFlagsAndArgs(core, io))
    .default(renderTui(core, io))
    .supportedTuiCommands("get", "list")
    .handler(createCreateOnlineInsightHandler(core, io))
    .handler(createGetOnlineInsightHandler(core))
    .handler(createListOnlineInsightHandler(core))
    .handler(createUpdateOnlineInsightHandler(core, io))
    .handler(createPauseOnlineInsightHandler(core))
    .handler(createResumeOnlineInsightHandler(core))
    .handler(createDeleteOnlineInsightHandler(core));
}

export { OnlineInsightScreen } from "./screen.tsx";
