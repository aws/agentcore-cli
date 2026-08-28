import z from "zod";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

const RECOMMENDATION_STATUSES = [
  "PENDING",
  "IN_PROGRESS",
  "COMPLETED",
  "FAILED",
  "DELETING",
] as const;

export const createListRecommendationsHandler = (core: Core) =>
  createHandler({
    name: "list",
    description: "list recommendations",
    flags: [
      flag("next-token", "pagination token returned by a previous request", z.string().optional()),
      flag("max-results", "maximum number of items to return", z.number().optional()),
      flag(
        "status-filter",
        `return only recommendations with this status (${RECOMMENDATION_STATUSES.join(" | ")})`,
        z.enum(RECOMMENDATION_STATUSES).optional(),
      ),
    ],
    handle: async (ctx, flags) => {
      const response = await core.eval.listRecommendations(
        flags["next-token"],
        flags["max-results"],
        flags["status-filter"],
        coreOptsFromCtx(ctx),
      );
      ctx.require(JsonRendererKey).renderJson(response);
    },
  });
