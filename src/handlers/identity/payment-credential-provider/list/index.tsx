import z from "zod";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export const createListPaymentCredentialProvidersHandler = (core: Core) =>
  createHandler({
    name: "list",
    description: "list payment credential providers",
    flags: [
      flag("next-token", "pagination token returned by a previous request", z.string().optional()),
      flag("max-results", "maximum number of items to return", z.number().optional()),
    ],
    handle: async (ctx, flags) => {
      ctx
        .require(JsonRendererKey)
        .renderJson(
          await core.identity.listPaymentCredentialProviders(
            flags["next-token"],
            flags["max-results"],
            coreOptsFromCtx(ctx),
          ),
        );
    },
  });
