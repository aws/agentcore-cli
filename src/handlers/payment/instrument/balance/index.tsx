import { BlockchainChainId, InstrumentBalanceToken } from "@aws-sdk/client-bedrock-agentcore";
import z from "zod";
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
      flag("manager-id", "the parent payment manager ID", z.string().min(1)),
      flag("connector-id", "the instrument's payment connector ID", z.string().min(1)),
      flag("instrument-id", "the payment instrument ID", z.string().min(1)),
      flag("user-id", "the application user ID associated with the instrument", z.string().min(1)),
      flag(
        "chain",
        `the blockchain chain to query (${Object.values(BlockchainChainId).join(" | ")})`,
        z.enum(BlockchainChainId),
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
