import z from "zod";
import type { AppIO } from "../../../../../io";
import { PaymentProviderSchema, type PaymentProvider } from "../../../../../projectSchemas/payment";
import { createHandler, flag } from "../../../../../router";
import type { AddProjectResourceConfig } from "../../types";
import { addCredentialToProject, type AddCredentialInput } from "../shared";
import {
  paymentCredentialInputFlags,
  resolvePaymentCredentialEnvEntries,
  type PaymentCredentialInputFlags,
} from "./input";

export type PaymentCredentialInput = {
  name: string;
  provider: PaymentProvider;
  flags: PaymentCredentialInputFlags;
  io?: Pick<AppIO, "stdin">;
};

export async function toAddPaymentCredentialInput(
  input: PaymentCredentialInput,
): Promise<AddCredentialInput> {
  return {
    resourceConfig: {
      authorizerType: "PaymentCredentialProvider",
      name: input.name,
      provider: input.provider,
    },
    envEntries: await resolvePaymentCredentialEnvEntries(input),
  };
}

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
      await addCredentialToProject(
        ctx,
        config,
        await toAddPaymentCredentialInput({
          name: flags.name,
          provider: flags.provider,
          flags,
          io: config.io,
        }),
      );
    },
  });
