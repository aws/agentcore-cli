import z from "zod";
import { InputValidationError } from "../../../../errors";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";
import type { ListPaymentSessionsInput } from "../../types";

export const createListPaymentSessionsHandler = (core: Core) =>
  createHandler({
    name: "list",
    description: "list a user's payment sessions under a payment manager (server-side paginated)",
    flags: [
      flag("manager-id", "the payment manager ID that owns the sessions", z.string().optional()),
      flag(
        "user-id",
        "the user whose sessions to list (required for IAM-authenticated calls)",
        z.string().optional(),
      ),
      flag("agent-name", "agent name recorded for observability", z.string().optional()),
      flag("next-token", "pagination token returned by a previous request", z.string().optional()),
      flag("max-results", "maximum number of items to return", z.number().optional()),
    ],
    handle: async (ctx, flags) => {
      if (!flags["manager-id"]) {
        throw new InputValidationError("required option '--manager-id <manager-id>' not specified");
      }
      if (!flags["user-id"]) {
        throw new InputValidationError("required option '--user-id <user-id>' not specified");
      }

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
