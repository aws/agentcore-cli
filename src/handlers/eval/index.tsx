import { Router } from "../../router";
import type { AppIO, Core } from "../types";
import { createHelpDefault } from "../help";
import { createEvaluatorHandler } from "./evaluator";

export function createEvalHandler(core: Core, io: AppIO): Router {
  return new Router("eval", "evaluate and optimize AgentCore agents")
    .default(createHelpDefault(io))
    .handler(createEvaluatorHandler(core, io));
}
