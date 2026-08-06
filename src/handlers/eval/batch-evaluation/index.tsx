import { Router } from "../../../router";
import { renderTui } from "../../../tui";
import { withTuiOnEmptyFlagsAndArgs } from "../../../middleware";
import type { AppIO } from "../../../io";
import type { Core } from "../../types";
import { createGetBatchEvaluationHandler } from "./get";
import { createListBatchEvaluationsHandler } from "./list";

// batch-evaluation is read-only (get + list). A bare invocation opens the
// interactive TUI (list → get), matching evaluator and online-eval.
export function createBatchEvaluationHandler(core: Core, io: AppIO): Router {
  return new Router("batch-evaluation", "inspect AgentCore batch evaluations")
    .use(withTuiOnEmptyFlagsAndArgs(core, io))
    .default(renderTui(core, io))
    .handler(createGetBatchEvaluationHandler(core, io))
    .handler(createListBatchEvaluationsHandler(core));
}

export { BatchEvaluationScreen } from "./screen.tsx";
