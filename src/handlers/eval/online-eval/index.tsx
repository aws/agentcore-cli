import { Router } from "../../../router";
import { renderTui } from "../../../tui";
import { withTuiOnEmptyFlagsAndArgs } from "../../../middleware";
import type { AppIO } from "../../../io";
import type { Core } from "../../types";
import { createCreateOnlineEvalHandler } from "./create";
import { createGetOnlineEvalHandler } from "./get";
import { createListOnlineEvalHandler } from "./list";
import { createUpdateOnlineEvalHandler } from "./update";
import { createPauseOnlineEvalHandler } from "./pause";
import { createResumeOnlineEvalHandler } from "./resume";
import { createDeleteOnlineEvalHandler } from "./delete";

export function createOnlineEvalHandler(core: Core, io: AppIO): Router {
  return new Router("online-eval", "manage AgentCore online evaluation configs")
    .use(withTuiOnEmptyFlagsAndArgs(core, io))
    .default(renderTui(core, io))
    .handler(createCreateOnlineEvalHandler(core, io))
    .handler(createGetOnlineEvalHandler(core))
    .handler(createListOnlineEvalHandler(core))
    .handler(createUpdateOnlineEvalHandler(core, io))
    .handler(createPauseOnlineEvalHandler(core))
    .handler(createResumeOnlineEvalHandler(core))
    .handler(createDeleteOnlineEvalHandler(core));
}

export { OnlineEvalScreen } from "./screen.tsx";
