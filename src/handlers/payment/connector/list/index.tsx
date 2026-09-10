import z from "zod";
import { InputValidationError } from "../../../../errors";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export const createListPaymentConnectorsHandler = (core: Core) =>
  createHandler({
    name: "list",
    description: "list the connectors of a payment manager (server-side paginated)",
    flags: [
      flag("manager-id", "the parent payment manager id", z.string().optional()),
      flag("next-token", "pagination token returned by a previous request", z.string().optional()),
      flag("max-results", "maximum number of items to return", z.number().optional()),
    ],
    handle: async (ctx, flags) => {
      if (!flags["manager-id"]) {
        throw new InputValidationError("required option '--manager-id <manager-id>' not specified");
      }

      ctx
        .require(JsonRendererKey)
        .renderJson(
          await core.payment.listPaymentConnectors(
            flags["manager-id"],
            flags["next-token"],
            flags["max-results"],
            coreOptsFromCtx(ctx),
          ),
        );
    },
  });
