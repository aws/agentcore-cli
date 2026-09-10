import z from "zod";
import { InputValidationError } from "../../../../errors";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export const createGetPaymentManagerHandler = (core: Core) =>
  createHandler({
    name: "get",
    description: "get a payment manager by id",
    flags: [flag("id", "the payment manager id", z.string().optional())],
    handle: async (ctx, flags) => {
      if (!flags.id) {
        throw new InputValidationError("required option '--id <id>' not specified");
      }

      ctx
        .require(JsonRendererKey)
        .renderJson(await core.payment.getPaymentManager(flags.id, coreOptsFromCtx(ctx)));
    },
  });
