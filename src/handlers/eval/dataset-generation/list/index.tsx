import z from "zod";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export const createListDatasetGenerationsHandler = (core: Core) =>
  createHandler({
    name: "list",
    description: "list a dataset's generations",
    flags: [
      flag("dataset-id", "the ID of the dataset", z.string().min(1)),
      flag("next-token", "pagination token returned by a previous request", z.string().optional()),
      flag("max-results", "maximum number of items to return", z.number().optional()),
    ],
    handle: async (ctx, flags) => {
      const response = await core.eval.listDatasetGenerations(
        flags["dataset-id"],
        flags["next-token"],
        flags["max-results"],
        coreOptsFromCtx(ctx),
      );
      ctx.require(JsonRendererKey).renderJson(response);
    },
  });
