import z from "zod";
import { InputValidationError } from "../../../../errors";
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
      flag("manager-id", "the payment manager ID that owns the instrument", z.string().optional()),
      flag(
        "user-id",
        "the user the instrument belongs to (required for IAM-authenticated calls)",
        z.string().optional(),
      ),
      flag("agent-name", "agent name recorded for observability", z.string().optional()),
      flag(
        "connector-id",
        "restrict the lookup to instruments under this payment connector",
        z.string().optional(),
      ),
      flag("instrument-id", "the payment instrument id", z.string().optional()),
    ],
    handle: async (ctx, flags) => {
      if (!flags["manager-id"]) {
        throw new InputValidationError("required option '--manager-id <manager-id>' not specified");
      }
      if (!flags["user-id"]) {
        throw new InputValidationError("required option '--user-id <user-id>' not specified");
      }
      if (!flags["instrument-id"]) {
        throw new InputValidationError(
          "required option '--instrument-id <instrument-id>' not specified",
        );
      }

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
