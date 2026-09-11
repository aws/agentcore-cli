import z from "zod";
import { InputValidationError } from "../../../../errors";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";
import type { DeletePaymentInstrumentInput } from "../../types";

// DeletePaymentInstrumentInput carries no agentName, so unlike the other
// instrument leaves this one offers no --agent-name.
export const createDeletePaymentInstrumentHandler = (core: Core) =>
  createHandler({
    name: "delete",
    description: "delete a payment instrument",
    flags: [
      flag("manager-id", "the payment manager ID that owns the instrument", z.string().optional()),
      flag(
        "user-id",
        "the user the instrument belongs to (required for IAM-authenticated calls)",
        z.string().optional(),
      ),
      flag(
        "connector-id",
        "the payment connector the instrument was created under",
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

      const request: DeletePaymentInstrumentInput = {
        managerId: flags["manager-id"],
        userId: flags["user-id"],
        paymentConnectorId: flags["connector-id"],
        paymentInstrumentId: flags["instrument-id"],
      };

      ctx
        .require(JsonRendererKey)
        .renderJson(await core.payment.deletePaymentInstrument(request, coreOptsFromCtx(ctx)));
    },
  });
