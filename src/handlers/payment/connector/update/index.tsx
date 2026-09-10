import z from "zod";
import { InputValidationError } from "../../../../errors";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";
import type { UpdatePaymentConnectorInput } from "../../types";

// No --type flag: the service rejects any change to a connector's type after
// creation. Like the manager leaf, an omitted flag leaves the field unchanged
// and there is no way to unset a description, so no --clear-* flags either.
export const createUpdatePaymentConnectorHandler = (core: Core) =>
  createHandler({
    name: "update",
    description: "update a payment connector",
    flags: [
      flag("manager-id", "the parent payment manager id", z.string().optional()),
      flag("connector-id", "the payment connector id", z.string().optional()),
      flag("description", "updated description", z.string().optional()),
      flag(
        "credential-provider",
        "replacement payment credential provider name or ARN (must match the connector type)",
        z.string().min(1).optional(),
      ),
      flag("client-token", "idempotency token", z.string().optional()),
    ],
    handle: async (ctx, flags) => {
      if (!flags["manager-id"]) {
        throw new InputValidationError("required option '--manager-id <manager-id>' not specified");
      }
      if (!flags["connector-id"]) {
        throw new InputValidationError(
          "required option '--connector-id <connector-id>' not specified",
        );
      }

      const input: UpdatePaymentConnectorInput = {
        managerId: flags["manager-id"],
        connectorId: flags["connector-id"],
        ...(flags.description !== undefined ? { description: flags.description } : {}),
        ...(flags["credential-provider"]
          ? { credentialProvider: flags["credential-provider"] }
          : {}),
        ...(flags["client-token"] ? { clientToken: flags["client-token"] } : {}),
      };

      ctx
        .require(JsonRendererKey)
        .renderJson(await core.payment.updatePaymentConnector(input, coreOptsFromCtx(ctx)));
    },
  });
