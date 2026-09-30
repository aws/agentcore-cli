import { Router } from "../../../../router";
import { renderTui } from "../../../../tui";
import type { Core } from "../../../types";
import type { AddProjectResourceConfig } from "../types";
import { createAddLlmAsAJudgeEvaluatorHandler } from "./llm-as-a-judge";
import { createAddCodeBasedEvaluatorHandler } from "./code-based";

export function createAddEvaluatorHandler(config: AddProjectResourceConfig, core: Core): Router {
  const evaluator = new Router("evaluator", "add a custom evaluator to the current project")
    .default(renderTui(core, config.io))
    .supportedTuiCommands("llm-as-a-judge", "code-based");
  evaluator.handler(createAddLlmAsAJudgeEvaluatorHandler(config));
  evaluator.handler(createAddCodeBasedEvaluatorHandler(config));
  return evaluator;
}
