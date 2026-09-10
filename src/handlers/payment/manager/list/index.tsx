import z from "zod";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export const createListPaymentManagersHandler = (core: Core) =>
  createHandler({
    name: "list",
    description: "list payment managers (server-side paginated)",
    flags: [
      flag("next-token", "pagination token returned by a previous request", z.string().optional()),
      flag("max-results", "maximum number of items to return", z.number().optional()),
    ],
    handle: async (ctx, flags) => {
      ctx
        .require(JsonRendererKey)
        .renderJson(
          await core.payment.listPaymentManagers(
            flags["next-token"],
            flags["max-results"],
            coreOptsFromCtx(ctx),
          ),
        );
    },
  });
