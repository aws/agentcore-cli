import z from "zod";
import { InputValidationError } from "../../../../errors";
import type { AppIO } from "../../../../io";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import { JsonKey } from "../../../keys";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export const createGetPaymentConnectorHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "get",
    description: "get a payment connector by id",
    flags: [
      flag("manager-id", "the parent payment manager ID (required)", z.string().optional()),
      flag("connector-id", "the payment connector ID (required)", z.string().optional()),
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

      const response = await core.payment.getPaymentConnector(
        flags["manager-id"],
        flags["connector-id"],
        coreOptsFromCtx(ctx),
      );
      ctx.require(JsonRendererKey).renderJson(response);

      // A lapsed or failed OAuth consent is terminal for a Quick Create
      // connector: the service issues no second authorization URL.
      if (
        !ctx.require(JsonKey) &&
        (response.status === "AUTHENTICATION_EXPIRED" ||
          response.status === "AUTHENTICATION_FAILED")
      ) {
        io.stderr.write(
          `warning: connector status is ${response.status}; its authorization URL cannot be renewed.\n`,
        );
      }
    },
  });
