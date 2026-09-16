import z from "zod";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";
import type { GetPaymentInstrumentInput } from "../../types";

export const createGetPaymentInstrumentHandler = (core: Core) =>
  createHandler({
    name: "get",
    description: "get a payment instrument by id",
    flags: [
      flag("manager-id", "the parent payment manager ID", z.string().min(1)),
      flag("instrument-id", "the payment instrument ID", z.string().min(1)),
      flag("user-id", "the application user ID associated with the instrument", z.string().min(1)),
      flag(
        "connector-id",
        "optionally restrict the lookup to this payment connector",
        z.string().optional(),
      ),
      flag(
        "agent-name",
        "optional observability label, not an agent selector",
        z.string().optional(),
      ),
    ],
    handle: async (ctx, flags) => {
      const request: GetPaymentInstrumentInput = {
        managerId: flags["manager-id"],
        userId: flags["user-id"],
        paymentInstrumentId: flags["instrument-id"],
        ...(flags["agent-name"] ? { agentName: flags["agent-name"] } : {}),
        ...(flags["connector-id"] ? { paymentConnectorId: flags["connector-id"] } : {}),
      };

      ctx
        .require(JsonRendererKey)
        .renderJson(await core.payment.getPaymentInstrument(request, coreOptsFromCtx(ctx)));
    },
  });
