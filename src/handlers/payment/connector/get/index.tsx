import z from "zod";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export const createGetPaymentConnectorHandler = (core: Core) =>
  createHandler({
    name: "get",
    description: "get a payment connector by id",
    flags: [
      flag("manager-id", "the parent payment manager ID", z.string().min(1)),
      flag("connector-id", "the payment connector ID", z.string().min(1)),
    ],
    handle: async (ctx, flags) => {
      const response = await core.payment.getPaymentConnector(
        flags["manager-id"],
        flags["connector-id"],
        coreOptsFromCtx(ctx),
      );
      ctx.require(JsonRendererKey).renderJson(response);
    },
  });
