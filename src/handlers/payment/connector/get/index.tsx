import z from "zod";
import { InputValidationError } from "../../../../errors";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export const createGetPaymentConnectorHandler = (core: Core) =>
  createHandler({
    name: "get",
    description: "get a payment connector by id",
    flags: [
      flag("manager-id", "the parent payment manager ID (required)", z.string().optional()),
      flag("connector-id", "the payment connector ID (required)", z.string().optional()),
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

      const response = await core.payment.getPaymentConnector(
        flags["manager-id"],
        flags["connector-id"],
        coreOptsFromCtx(ctx),
      );
      ctx.require(JsonRendererKey).renderJson(response);
    },
  });
