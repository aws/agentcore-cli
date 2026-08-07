import { Router } from "../../../router";
import { createHelpDefault } from "../../help";
import type { AppIO } from "../../../io";
import type { Core } from "../../types";
import { createGetBatchEvaluationHandler } from "./get";
import { createListBatchEvaluationsHandler } from "./list";

// batch-evaluation is read-only for now (get + list). Unlike evaluator and
// online-eval it has no TUI screen yet, so a bare invocation prints help rather
// than launching Ink — matching the gateway/target read-only group.
export function createBatchEvaluationHandler(core: Core, io: AppIO): Router {
  return new Router("batch-evaluation", "inspect AgentCore batch evaluations")
    .default(createHelpDefault(io))
    .handler(createGetBatchEvaluationHandler(core, io))
    .handler(createListBatchEvaluationsHandler(core));
}
