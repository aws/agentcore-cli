import z from "zod";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export const createGetPaymentCredentialProviderHandler = (core: Core) =>
  createHandler({
    name: "get",
    description: "get a payment credential provider",
    flags: [flag("name", "the payment credential provider name", z.string().min(1))],
    handle: async (ctx, flags) => {
      ctx
        .require(JsonRendererKey)
        .renderJson(
          await core.identity.getPaymentCredentialProvider(flags.name, coreOptsFromCtx(ctx)),
        );
    },
  });
