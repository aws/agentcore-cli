import { Router } from "../../../../router";
import type { AddProjectResourceConfig } from "../types";
import { createAddLlmAsAJudgeEvaluatorHandler } from "./llm-as-a-judge";
import { createAddCodeBasedEvaluatorHandler } from "./code-based";

export function createAddEvaluatorHandler(config: AddProjectResourceConfig): Router {
  const evaluator = new Router("evaluator", "add a custom evaluator to the current project");
  evaluator.handler(createAddLlmAsAJudgeEvaluatorHandler(config));
  evaluator.handler(createAddCodeBasedEvaluatorHandler(config));
  return evaluator;
}
