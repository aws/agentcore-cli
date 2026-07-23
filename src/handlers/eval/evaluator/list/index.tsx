import z from "zod";
import { EvaluatorType } from "@aws-sdk/client-bedrock-agentcore-control";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

const TYPE_FILTERS = ["builtin", "code-based", "llm-as-a-judge"] as const;

// The AgentCore ListEvaluators API only paginates (nextToken/maxResults); it does
// not filter by type. `--type` is therefore applied client-side to the returned
// page, so combining it with --max-results can under-fill a page.
const TYPE_TO_SDK: Record<(typeof TYPE_FILTERS)[number], string> = {
  builtin: EvaluatorType.BUILTIN,
  "code-based": EvaluatorType.CODE,
  "llm-as-a-judge": EvaluatorType.CUSTOM,
};

export const createListEvaluatorsHandler = (core: Core) =>
  createHandler({
    name: "list",
    description: "list evaluators",
    flags: [
      flag("next-token", "pagination token returned by a previous request", z.string().optional()),
      flag("max-results", "maximum number of items to return", z.number().optional()),
      flag(
        "type",
        `filter the returned page by type (${TYPE_FILTERS.join(" | ")})`,
        z.enum(TYPE_FILTERS).optional(),
      ),
    ],
    handle: async (ctx, flags) => {
      const response = await core.eval.listEvaluators(
        flags["next-token"],
        flags["max-results"],
        coreOptsFromCtx(ctx),
      );

      const type = flags["type"];
      if (type && response.evaluators) {
        const wanted = TYPE_TO_SDK[type];
        response.evaluators = response.evaluators.filter((e) => e.evaluatorType === wanted);
      }

      ctx.require(JsonRendererKey).renderJson(response);
    },
  });
