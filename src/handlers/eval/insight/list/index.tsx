import z from "zod";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

const ARCHIVE_STATUSES = ["ACTIVE", "ARCHIVED"] as const;

// The service accepts at most one of --application-name or --batch-evaluation-id;
// with neither, it lists across the account. Its error is relayed unchanged.
export const createListInsightsHandler = (core: Core) =>
  createHandler({
    name: "list",
    description: "list Agent Insights for an application or a batch evaluation",
    flags: [
      flag(
        "application-name",
        "list the Insights of this application",
        z.string().min(1).optional(),
      ),
      flag(
        "batch-evaluation-id",
        "list the Insights a batch evaluation produced",
        z.string().min(1).optional(),
      ),
      flag(
        "archive-status",
        `list only Insights in this archive state (${ARCHIVE_STATUSES.join(" | ")})`,
        z.enum(ARCHIVE_STATUSES).optional(),
      ),
      flag("next-token", "pagination token returned by a previous request", z.string().optional()),
      flag("max-results", "maximum number of items to return (1-50)", z.number().optional()),
    ],
    handle: async (ctx, flags) => {
      ctx.require(JsonRendererKey).renderJson(
        await core.eval.listAgentInsights(
          {
            applicationName: flags["application-name"],
            batchEvaluationId: flags["batch-evaluation-id"],
            archiveStatus: flags["archive-status"],
            nextToken: flags["next-token"],
            maxResults: flags["max-results"],
          },
          coreOptsFromCtx(ctx),
        ),
      );
    },
  });
