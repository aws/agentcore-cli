import z from "zod";
import { InputValidationError } from "../../../../errors";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";
import type { DeletePaymentSessionInput } from "../../types";

// DeletePaymentSessionInput carries no agentName, so unlike the other session
// leaves this one offers no --agent-name.
export const createDeletePaymentSessionHandler = (core: Core) =>
  createHandler({
    name: "delete",
    description: "delete a payment session",
    flags: [
      flag("manager-id", "the payment manager ID that owns the session", z.string().optional()),
      flag(
        "user-id",
        "the user the session is scoped to (required for IAM-authenticated calls)",
        z.string().optional(),
      ),
      flag("session-id", "the payment session id", z.string().optional()),
    ],
    handle: async (ctx, flags) => {
      if (!flags["manager-id"]) {
        throw new InputValidationError("required option '--manager-id <manager-id>' not specified");
      }
      if (!flags["user-id"]) {
        throw new InputValidationError("required option '--user-id <user-id>' not specified");
      }
      if (!flags["session-id"]) {
        throw new InputValidationError("required option '--session-id <session-id>' not specified");
      }

      const request: DeletePaymentSessionInput = {
        managerId: flags["manager-id"],
        userId: flags["user-id"],
        paymentSessionId: flags["session-id"],
      };

      ctx
        .require(JsonRendererKey)
        .renderJson(await core.payment.deletePaymentSession(request, coreOptsFromCtx(ctx)));
    },
  });
