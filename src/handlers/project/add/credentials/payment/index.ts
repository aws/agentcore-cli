import z from "zod";
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
      flag("name", "the name of the credential provider", z.string().min(1)),
      flag("provider", "the payment provider: CoinbaseCDP or StripePrivy", PaymentProviderSchema),
      ...paymentCredentialInputFlags,
    ],
    handle: async (ctx, flags) => {
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
