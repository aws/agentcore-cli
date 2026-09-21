import z from "zod";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export const createGetPaymentManagerHandler = (core: Core) =>
  createHandler({
    name: "get",
    description: "get a payment manager by id",
    flags: [flag("id", "the payment manager ID", z.string().min(1))],
    handle: async (ctx, flags) => {
      ctx
        .require(JsonRendererKey)
        .renderJson(await core.payment.getPaymentManager(flags.id, coreOptsFromCtx(ctx)));
    },
  });
