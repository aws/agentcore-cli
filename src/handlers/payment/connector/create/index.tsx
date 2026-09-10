import z from "zod";
import { InputValidationError } from "../../../../errors";
import type { AppIO } from "../../../../io";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import { JsonKey } from "../../../keys";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";
import type { CreatePaymentConnectorInput } from "../../types";

export const createCreatePaymentConnectorHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "create",
    description: "create a payment connector under a payment manager",
    flags: [
      flag("manager-id", "the parent payment manager id", z.string().optional()),
      flag("name", "the payment connector name", z.string().optional()),
      flag("description", "payment connector description", z.string().optional()),
      flag(
        "type",
        "connector type: CoinbaseCDP or StripePrivy (inferred from a credential provider name; required with an ARN)",
        z.enum(["CoinbaseCDP", "StripePrivy"]).optional(),
      ),
      flag(
        "credential-provider",
        "payment credential provider name or ARN that backs the connector",
        z.string().min(1).optional(),
      ),
      flag(
        "quick-create",
        "let Coinbase provision the credentials after OAuth consent (CoinbaseCDP only)",
        z.boolean().default(false),
      ),
      flag("client-token", "idempotency token", z.string().optional()),
    ],
    handle: async (ctx, flags) => {
      // Required at runtime but declared optional so that a bare invocation can
      // fall through to the TUI once a screen exists.
      if (!flags["manager-id"]) {
        throw new InputValidationError("required option '--manager-id <manager-id>' not specified");
      }
      if (!flags.name) {
        throw new InputValidationError("required option '--name <name>' not specified");
      }
      if (flags["quick-create"] === (flags["credential-provider"] !== undefined)) {
        throw new InputValidationError(
          "specify exactly one of '--quick-create' or '--credential-provider'",
        );
      }

      const input: CreatePaymentConnectorInput = {
        managerId: flags["manager-id"],
        name: flags.name,
        ...(flags.description ? { description: flags.description } : {}),
        ...(flags.type ? { type: flags.type } : {}),
        ...(flags["credential-provider"]
          ? { credentialProvider: flags["credential-provider"] }
          : {}),
        ...(flags["quick-create"] ? { quickCreate: true } : {}),
        ...(flags["client-token"] ? { clientToken: flags["client-token"] } : {}),
      };

      const options = coreOptsFromCtx(ctx);
      const response = await core.payment.createPaymentConnector(input, options);
      ctx.require(JsonRendererKey).renderJson(response);

      // Quick Create leaves the connector waiting on OAuth consent; the URL is
      // in the JSON, but a scripted caller does not need the walkthrough.
      if (
        !ctx.require(JsonKey) &&
        response.status === "PENDING_AUTHENTICATION" &&
        response.authorizationUrl
      ) {
        const command = [
          "agentcore",
          "payment",
          "connector",
          "get",
          "--manager-id",
          flags["manager-id"],
          "--connector-id",
          response.paymentConnectorId ?? "<connector-id>",
          "--region",
          options.region,
          ...(options.endpointUrl !== undefined ? ["--endpoint-url", options.endpointUrl] : []),
        ]
          .map((value) =>
            /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`,
          )
          .join(" ");
        io.stderr.write(
          `Open ${response.authorizationUrl} within about 10 minutes to authorize with Coinbase, then run ` +
            `\`${command}\` ` +
            "to confirm the connector is READY.\n",
        );
      }
    },
  });
