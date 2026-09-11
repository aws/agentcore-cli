import z from "zod";
import { InputValidationError } from "../../../../errors";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export const createDeletePaymentConnectorHandler = (core: Core) =>
  createHandler({
    name: "delete",
    description: "delete a payment connector",
    flags: [
      flag("manager-id", "the parent payment manager id", z.string().optional()),
      flag("connector-id", "the payment connector id", z.string().optional()),
      flag("client-token", "idempotency token", z.string().optional()),
    ],
    handle: async (ctx, flags) => {
      if (!flags["manager-id"]) {
        throw new InputValidationError("required option '--manager-id <manager-id>' not specified");
      }
      if (!flags["connector-id"]) {
        throw new InputValidationError(
          "required option '--connector-id <connector-id>' not specified",
        );
      }

      ctx.require(JsonRendererKey).renderJson(
        await core.payment.deletePaymentConnector(
          {
            paymentManagerId: flags["manager-id"],
            paymentConnectorId: flags["connector-id"],
            ...(flags["client-token"] ? { clientToken: flags["client-token"] } : {}),
          },
          coreOptsFromCtx(ctx),
        ),
      );
    },
  });
