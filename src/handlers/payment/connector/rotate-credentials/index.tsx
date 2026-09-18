import { CoinbaseCdpSecret } from "@aws-sdk/client-bedrock-agentcore-control";
import z from "zod";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export const createRotatePaymentConnectorCredentialsHandler = (core: Core) =>
  createHandler({
    name: "rotate-credentials",
    description: "rotate service-managed credentials for a Quick Create Coinbase connector",
    flags: [
      flag("manager-id", "the parent payment manager ID", z.string().min(1)),
      flag("connector-id", "the payment connector ID", z.string().min(1)),
      flag(
        "secrets",
        "credential kinds to rotate: API_KEY, WALLET_SECRET, or both (not secret values)",
        z
          .array(z.enum(CoinbaseCdpSecret))
          .min(1)
          .refine((secrets) => new Set(secrets).size === secrets.length, {
            message: "credential selections must be unique",
          }),
      ),
      flag("client-token", "idempotency token for this request", z.string().optional()),
    ],
    handle: async (ctx, flags) => {
      const response = await core.payment.rotatePaymentConnectorCredentials(
        {
          paymentManagerId: flags["manager-id"],
          paymentConnectorId: flags["connector-id"],
          credentialsToRotate: { coinbaseCDP: { secrets: flags.secrets } },
          clientToken: flags["client-token"],
        },
        coreOptsFromCtx(ctx),
      );
      ctx.require(JsonRendererKey).renderJson(response);
    },
  });
