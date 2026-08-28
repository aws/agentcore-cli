import z from "zod";
import { InputValidationError } from "../../../../../errors";
import { PaymentProviderSchema } from "../../../../../projectSchemas/payment";
import { createHandler, flag } from "../../../../../router";
import type { AddProjectResourceConfig } from "../../types";
import { addCredentialToProject } from "../shared";
import { paymentCredentialInputFlags, resolvePaymentCredentialEnvEntries } from "./input";

export const createAddPaymentCredentialHandler = (config: AddProjectResourceConfig) =>
  createHandler({
    name: "payment",
    description: "add a payment credential provider to the current project",
    flags: [
      flag("name", "the name of the credential provider", z.string().optional()),
      flag(
        "provider",
        "the payment provider: CoinbaseCDP or StripePrivy",
        PaymentProviderSchema.optional(),
      ),
      ...paymentCredentialInputFlags,
    ],
    handle: async (ctx, flags) => {
      if (!flags.name) {
        throw new InputValidationError("required option '--name <name>' not specified");
      }
      if (!flags.provider) {
        throw new InputValidationError("required option '--provider <provider>' not specified");
      }

      const envEntries = await resolvePaymentCredentialEnvEntries({
        name: flags.name,
        provider: flags.provider,
        flags,
        io: config.io,
      });
      await addCredentialToProject(ctx, config, {
        resourceConfig: {
          authorizerType: "PaymentCredentialProvider",
          name: flags.name,
          provider: flags.provider,
        },
        envEntries,
      });
    },
  });
