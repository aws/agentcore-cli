import z from "zod";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { AppIO } from "../../../../io";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export const createGetAbTestHandler = (core: Core, _io: AppIO) =>
  createHandler({
    name: "get",
    description: "get an A/B test by ID, with per-evaluator comparison metrics",
    flags: [flag("id", "the ID of the A/B test", z.string().min(1))],
    handle: async (ctx, flags) => {
      const id = flags["id"];
      const detail = await core.eval.getABTest(id, coreOptsFromCtx(ctx));
      ctx.require(JsonRendererKey).renderJson(detail);
    },
  });
