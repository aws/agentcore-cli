import type { Currency } from "@aws-sdk/client-bedrock-agentcore";
import z from "zod";
import { InputValidationError } from "../../../../errors";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";
import type { CreatePaymentSessionInput } from "../../types";

// The service accepts only USD today. Pinning the list against the SDK type
// turns a new Currency value into a compile-time reminder to widen this.
const CURRENCIES = ["USD"] as const satisfies readonly Currency[];
const DEFAULT_CURRENCY: Currency = "USD";

export const createCreatePaymentSessionHandler = (core: Core) =>
  createHandler({
    name: "create",
    description: "create a payment session (a time-boxed payment context with a spend limit)",
    flags: [
      flag("manager-id", "the payment manager ID that owns the session", z.string().optional()),
      flag(
        "user-id",
        "the user the session is scoped to (required for IAM-authenticated calls)",
        z.string().optional(),
      ),
      flag("agent-name", "agent name recorded for observability", z.string().optional()),
      flag(
        "expiry-minutes",
        "how long the session stays active, in minutes (15 to 480)",
        z.number().int().min(15).max(480).optional(),
      ),
      flag(
        "max-spend",
        "maximum amount the session may spend, as a decimal string (e.g. 25.00)",
        z.string().optional(),
      ),
      flag(
        "currency",
        `currency of --max-spend (${CURRENCIES.join(" | ")}; default ${DEFAULT_CURRENCY})`,
        z.enum(CURRENCIES).optional(),
      ),
      flag("client-token", "idempotency token", z.string().optional()),
    ],
    handle: async (ctx, flags) => {
      // Required at runtime but declared optional so that a bare invocation can
      // fall through to the TUI once a screen exists.
      if (!flags["manager-id"]) {
        throw new InputValidationError("required option '--manager-id <manager-id>' not specified");
      }
      if (!flags["user-id"]) {
        throw new InputValidationError("required option '--user-id <user-id>' not specified");
      }
      if (flags["expiry-minutes"] === undefined) {
        throw new InputValidationError(
          "required option '--expiry-minutes <expiry-minutes>' not specified",
        );
      }
      const maxSpend = flags["max-spend"];
      if (maxSpend !== undefined && maxSpend.trim() === "") {
        throw new InputValidationError("--max-spend must not be empty or whitespace");
      }
      if (flags.currency !== undefined && maxSpend === undefined) {
        throw new InputValidationError("--currency requires --max-spend");
      }

      const request: CreatePaymentSessionInput = {
        managerId: flags["manager-id"],
        userId: flags["user-id"],
        expiryTimeInMinutes: flags["expiry-minutes"],
        ...(flags["agent-name"] ? { agentName: flags["agent-name"] } : {}),
        ...(maxSpend !== undefined
          ? {
              limits: {
                maxSpendAmount: {
                  value: maxSpend,
                  currency: flags.currency ?? DEFAULT_CURRENCY,
                },
              },
            }
          : {}),
        ...(flags["client-token"] ? { clientToken: flags["client-token"] } : {}),
      };

      ctx
        .require(JsonRendererKey)
        .renderJson(await core.payment.createPaymentSession(request, coreOptsFromCtx(ctx)));
    },
  });
