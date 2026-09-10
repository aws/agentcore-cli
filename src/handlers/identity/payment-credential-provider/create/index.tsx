import z from "zod";
import { InputValidationError } from "../../../../errors";
import type { AppIO } from "../../../../io";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx, parseTags } from "../../../utils";
import {
  PaymentProviderConfigurationResolver,
  paymentCredentialProviderConfigFlags,
} from "../flags";

export const createCreatePaymentCredentialProviderHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "create",
    description: "create a payment credential provider",
    flags: [
      flag("name", "the name of the payment credential provider", z.string().optional()),
      ...paymentCredentialProviderConfigFlags,
      flag("tags", "tags as key=value (repeatable) or JSON object", z.array(z.string()).optional()),
    ],
    handle: async (ctx, flags) => {
      if (!flags.name) {
        throw new InputValidationError("required option '--name <name>' not specified");
      }

      const configuration = await new PaymentProviderConfigurationResolver(flags, io).resolve();

      ctx
        .require(JsonRendererKey)
        .renderJson(
          await core.identity.createPaymentCredentialProvider(
            { name: flags.name, ...configuration, tags: parseTags(flags.tags) },
            coreOptsFromCtx(ctx),
          ),
        );
    },
  });
