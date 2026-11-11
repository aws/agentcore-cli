import z from "zod";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";
import { InsightTarget } from "../insightTarget";

const ARCHIVE_STATUSES = ["ACTIVE", "ARCHIVED"] as const;

export const createUpdateInsightHandler = (core: Core) =>
  createHandler({
    name: "update",
    description: "archive an Agent Insight, or restore an archived one",
    flags: [
      ...InsightTarget.flags,
      flag(
        "archive-status",
        `the archive state to set (${ARCHIVE_STATUSES.join(" | ")})`,
        z.enum(ARCHIVE_STATUSES),
      ),
    ],
    handle: async (ctx, flags) => {
      ctx
        .require(JsonRendererKey)
        .renderJson(
          await core.eval.updateAgentInsight(
            { ...InsightTarget.resolve(flags), archiveStatus: flags["archive-status"] },
            coreOptsFromCtx(ctx),
          ),
        );
    },
  });
