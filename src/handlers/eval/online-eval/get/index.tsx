import z from "zod";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";
import type { AppIO } from "../../../../io";
import { noteInsights } from "../insightsNote";

export const createGetOnlineEvalHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "get",
    description: "get an online evaluation config by ID",
    flags: [flag("id", "the ID of the online evaluation config", z.string().min(1))],
    handle: async (ctx, flags) => {
      const config = await core.eval.getOnlineEvaluationConfig(flags["id"], coreOptsFromCtx(ctx));
      noteInsights(io, config);
      ctx.require(JsonRendererKey).renderJson(config);
    },
  });
