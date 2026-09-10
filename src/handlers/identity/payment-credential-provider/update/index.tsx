import z from "zod";
import { InputValidationError } from "../../../../errors";
import type { AppIO } from "../../../../io";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";
import {
  PaymentProviderConfigurationResolver,
  paymentCredentialProviderConfigFlags,
} from "../flags";

// The service replaces the whole vendor configuration on update, so the flags
// and validation are the same as create minus tags.
export const createUpdatePaymentCredentialProviderHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "update",
    description: "update a payment credential provider",
    flags: [
      flag("name", "the name of the payment credential provider", z.string().optional()),
      ...paymentCredentialProviderConfigFlags,
    ],
    handle: async (ctx, flags) => {
      if (!flags.name) {
        throw new InputValidationError("required option '--name <name>' not specified");
      }

      const configuration = await new PaymentProviderConfigurationResolver(flags, io).resolve();

      ctx
        .require(JsonRendererKey)
        .renderJson(
          await core.identity.updatePaymentCredentialProvider(
            { name: flags.name, ...configuration },
            coreOptsFromCtx(ctx),
          ),
        );
    },
  });
