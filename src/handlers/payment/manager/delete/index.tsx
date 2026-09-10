import z from "zod";
import { InputValidationError } from "../../../../errors";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export const createDeletePaymentManagerHandler = (core: Core) =>
  createHandler({
    name: "delete",
    description: "delete a payment manager (delete its connectors first)",
    flags: [
      flag("id", "the payment manager id", z.string().optional()),
      flag("client-token", "idempotency token", z.string().optional()),
    ],
    handle: async (ctx, flags) => {
      if (!flags.id) {
        throw new InputValidationError("required option '--id <id>' not specified");
      }

      ctx.require(JsonRendererKey).renderJson(
        await core.payment.deletePaymentManager(
          {
            paymentManagerId: flags.id,
            ...(flags["client-token"] ? { clientToken: flags["client-token"] } : {}),
          },
          coreOptsFromCtx(ctx),
        ),
      );
    },
  });
