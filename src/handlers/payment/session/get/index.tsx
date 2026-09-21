import z from "zod";
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
      flag("manager-id", "the parent payment manager ID", z.string().min(1)),
      flag("session-id", "the payment session ID", z.string().min(1)),
      flag("user-id", "the application user ID associated with the session", z.string().min(1)),
      flag(
        "agent-name",
        "optional observability label, not an agent selector",
        z.string().optional(),
      ),
    ],
    handle: async (ctx, flags) => {
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
