import { Router } from "../../../../router";
import type { AppIO, Core } from "../../../types";
import { createHelpDefault } from "../../../help";
import { createLlmAsAJudgeCreateHandler } from "./create";
import { createLlmAsAJudgeUpdateHandler } from "./update";

export function createLlmAsAJudgeHandler(core: Core, io: AppIO): Router {
  return new Router("llm-as-a-judge", "manage LLM-as-a-Judge evaluators")
    .default(createHelpDefault(io))
    .handler(createLlmAsAJudgeCreateHandler(core, io))
    .handler(createLlmAsAJudgeUpdateHandler(core, io));
}
