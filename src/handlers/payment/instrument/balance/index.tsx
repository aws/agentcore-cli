import { BlockchainChainId, InstrumentBalanceToken } from "@aws-sdk/client-bedrock-agentcore";
import z from "zod";
import { InputValidationError } from "../../../../errors";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";
import type { GetPaymentInstrumentBalanceInput } from "../../types";

export const createGetPaymentInstrumentBalanceHandler = (core: Core) =>
  createHandler({
    name: "balance",
    description: "get a payment instrument's token balance on a specific chain",
    flags: [
      flag("manager-id", "the parent payment manager ID (required)", z.string().optional()),
      flag(
        "connector-id",
        "the instrument's payment connector ID (required)",
        z.string().optional(),
      ),
      flag("instrument-id", "the payment instrument ID (required)", z.string().optional()),
      flag(
        "user-id",
        "the application user ID associated with the instrument (required)",
        z.string().optional(),
      ),
      flag(
        "chain",
        `the blockchain chain to query (required; ${Object.values(BlockchainChainId).join(" | ")})`,
        z.enum(BlockchainChainId).optional(),
      ),
      flag(
        "token",
        `the token to query (${Object.values(InstrumentBalanceToken).join(" | ")})`,
        z.enum(InstrumentBalanceToken).default(InstrumentBalanceToken.USDC),
      ),
      flag(
        "agent-name",
        "optional observability label, not an agent selector",
        z.string().optional(),
      ),
    ],
    handle: async (ctx, flags) => {
      if (!flags["manager-id"]) {
        throw new InputValidationError("required option '--manager-id <manager-id>' not specified");
      }
      if (!flags["user-id"]) {
        throw new InputValidationError("required option '--user-id <user-id>' not specified");
      }
      if (!flags["connector-id"]) {
        throw new InputValidationError(
          "required option '--connector-id <connector-id>' not specified",
        );
      }
      if (!flags["instrument-id"]) {
        throw new InputValidationError(
          "required option '--instrument-id <instrument-id>' not specified",
        );
      }
      if (!flags["chain"]) {
        throw new InputValidationError("required option '--chain <chain>' not specified");
      }

      const request: GetPaymentInstrumentBalanceInput = {
        managerId: flags["manager-id"],
        userId: flags["user-id"],
        paymentConnectorId: flags["connector-id"],
        paymentInstrumentId: flags["instrument-id"],
        chain: flags["chain"],
        token: flags["token"],
        ...(flags["agent-name"] ? { agentName: flags["agent-name"] } : {}),
      };

      ctx
        .require(JsonRendererKey)
        .renderJson(await core.payment.getPaymentInstrumentBalance(request, coreOptsFromCtx(ctx)));
    },
  });
