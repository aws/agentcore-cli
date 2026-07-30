import { Router } from "../../../router";
import type { AppIO } from "../../../io";
import type { Core } from "../../types";
import { createHelpDefault } from "../../help";
import { createCreateOnlineEvalHandler } from "./create";
import { createGetOnlineEvalHandler } from "./get";
import { createListOnlineEvalHandler } from "./list";
import { createUpdateOnlineEvalHandler } from "./update";
import { createPauseOnlineEvalHandler } from "./pause";
import { createResumeOnlineEvalHandler } from "./resume";
import { createDeleteOnlineEvalHandler } from "./delete";

export function createOnlineEvalHandler(core: Core, io: AppIO): Router {
  return new Router("online-eval", "manage AgentCore online evaluation configs")
    .default(createHelpDefault(io))
    .handler(createCreateOnlineEvalHandler(core, io))
    .handler(createGetOnlineEvalHandler(core))
    .handler(createListOnlineEvalHandler(core))
    .handler(createUpdateOnlineEvalHandler(core, io))
    .handler(createPauseOnlineEvalHandler(core))
    .handler(createResumeOnlineEvalHandler(core))
    .handler(createDeleteOnlineEvalHandler(core));
}
