import z from "zod";
import { InputValidationError } from "../../../../errors";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";
import type { ListPaymentInstrumentsInput } from "../../types";

export const createListPaymentInstrumentsHandler = (core: Core) =>
  createHandler({
    name: "list",
    description:
      "list a user's payment instruments under a payment manager (server-side paginated)",
    flags: [
      flag("manager-id", "the payment manager ID that owns the instruments", z.string().optional()),
      flag(
        "user-id",
        "the user whose instruments to list (required for IAM-authenticated calls)",
        z.string().optional(),
      ),
      flag("agent-name", "agent name recorded for observability", z.string().optional()),
      flag(
        "connector-id",
        "only list instruments under this payment connector",
        z.string().optional(),
      ),
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

      const request: ListPaymentInstrumentsInput = {
        managerId: flags["manager-id"],
        userId: flags["user-id"],
        ...(flags["agent-name"] ? { agentName: flags["agent-name"] } : {}),
        ...(flags["connector-id"] ? { paymentConnectorId: flags["connector-id"] } : {}),
        ...(flags["next-token"] ? { nextToken: flags["next-token"] } : {}),
        ...(flags["max-results"] !== undefined ? { maxResults: flags["max-results"] } : {}),
      };

      ctx
        .require(JsonRendererKey)
        .renderJson(await core.payment.listPaymentInstruments(request, coreOptsFromCtx(ctx)));
    },
  });
