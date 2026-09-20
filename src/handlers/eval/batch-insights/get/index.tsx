import z from "zod";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export const createGetBatchInsightsHandler = (core: Core) =>
  createHandler({
    name: "get",
    description: "get a batch insights run and its reports by ID",
    flags: [flag("id", "the ID of the batch insights run", z.string().min(1))],
    handle: async (ctx, flags) => {
      const id = flags["id"];

      const detail = await core.eval.getBatchInsights(id, coreOptsFromCtx(ctx));

      ctx.require(JsonRendererKey).renderJson(detail);
    },
  });

export { BatchInsightsGetJsonScreen } from "./screen.tsx";
