import z from "zod";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";
import type { ListPaymentSessionsInput } from "../../types";

export const createListPaymentSessionsHandler = (core: Core) =>
  createHandler({
    name: "list",
    description: "list an application user's payment sessions under a payment manager",
    flags: [
      flag("manager-id", "the parent payment manager ID", z.string().min(1)),
      flag("user-id", "the application user ID to list sessions for", z.string().min(1)),
      flag("next-token", "pagination token returned by a previous request", z.string().optional()),
      flag("max-results", "maximum number of items to return", z.number().optional()),
      flag(
        "agent-name",
        "optional observability label, not an agent selector",
        z.string().optional(),
      ),
    ],
    handle: async (ctx, flags) => {
      const request: ListPaymentSessionsInput = {
        managerId: flags["manager-id"],
        userId: flags["user-id"],
        ...(flags["agent-name"] ? { agentName: flags["agent-name"] } : {}),
        ...(flags["next-token"] ? { nextToken: flags["next-token"] } : {}),
        ...(flags["max-results"] !== undefined ? { maxResults: flags["max-results"] } : {}),
      };

      ctx
        .require(JsonRendererKey)
        .renderJson(await core.payment.listPaymentSessions(request, coreOptsFromCtx(ctx)));
    },
  });
