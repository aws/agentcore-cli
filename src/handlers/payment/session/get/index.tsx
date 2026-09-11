import z from "zod";
import { InputValidationError } from "../../../../errors";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";
import type { GetPaymentSessionInput } from "../../types";

export const createGetPaymentSessionHandler = (core: Core) =>
  createHandler({
    name: "get",
    description: "get a payment session by id",
    flags: [
      flag("manager-id", "the parent payment manager ID (required)", z.string().optional()),
      flag("session-id", "the payment session ID (required)", z.string().optional()),
      flag(
        "user-id",
        "the application user ID associated with the session (required)",
        z.string().optional(),
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
      if (!flags["session-id"]) {
        throw new InputValidationError("required option '--session-id <session-id>' not specified");
      }

      const request: GetPaymentSessionInput = {
        managerId: flags["manager-id"],
        userId: flags["user-id"],
        paymentSessionId: flags["session-id"],
        ...(flags["agent-name"] ? { agentName: flags["agent-name"] } : {}),
      };

      ctx
        .require(JsonRendererKey)
        .renderJson(await core.payment.getPaymentSession(request, coreOptsFromCtx(ctx)));
    },
  });
