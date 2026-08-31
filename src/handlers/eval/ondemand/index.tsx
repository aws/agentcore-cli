import { Router } from "../../../router";
import type { AppIO } from "../../../io";
import type { Core } from "../../types";
import { createHelpDefault } from "../../help";
import { createEvaluateOnDemandHandler } from "./evaluate";
import { createSimulateOnDemandHandler } from "./simulate";

// ondemand groups the synchronous, client-side evaluation commands. It has no TUI
// screen (unlike evaluator/online-eval), so a bare invocation prints help.
export function createOnDemandHandler(core: Core, io: AppIO): Router {
  return new Router("ondemand", "evaluate existing sessions synchronously, client-side")
    .default(createHelpDefault(io))
    .handler(createEvaluateOnDemandHandler(core, io))
    .handler(createSimulateOnDemandHandler(core, io));
}
