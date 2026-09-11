import type { AuthorizerConfiguration } from "@aws-sdk/client-bedrock-agentcore-control";
import z from "zod";
import { InputValidationError } from "../../../../errors";
import { type AppIO, SourceResolver } from "../../../../io";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx, parseJsonObjectFlag } from "../../../utils";
import type { UpdatePaymentManagerInput } from "../../types";

// The payment APIs are PATCH-style with no clear wrapper: an omitted flag leaves
// the field unchanged, and there is no way to unset a description, KMS key, or
// authorizer configuration, so the CLI offers no --clear-* flags here.
export const createUpdatePaymentManagerHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "update",
    description: "update a payment manager",
    flags: [
      flag("id", "the payment manager id", z.string().optional()),
      flag("description", "updated description", z.string().optional()),
      flag(
        "authorizer-type",
        "updated data-plane authorizer: AWS_IAM or CUSTOM_JWT",
        z.enum(["AWS_IAM", "CUSTOM_JWT"]).optional(),
      ),
      flag(
        "authorizer-configuration",
        "replacement CUSTOM_JWT configuration (JSON AuthorizerConfiguration; inline, file://<path>, or - for stdin)",
        z.string().optional(),
      ),
      flag(
        "role-arn",
        "updated IAM role the Payments service assumes",
        z.string().min(1).optional(),
      ),
      flag("kms-key-arn", "updated customer managed KMS key ARN", z.string().min(1).optional()),
      flag("client-token", "idempotency token", z.string().optional()),
    ],
    handle: async (ctx, flags) => {
      if (!flags.id) {
        throw new InputValidationError("required option '--id <id>' not specified");
      }
      if (
        flags["authorizer-type"] === "AWS_IAM" &&
        flags["authorizer-configuration"] !== undefined
      ) {
        throw new InputValidationError("--authorizer-configuration is valid only with CUSTOM_JWT");
      }

      const source = new SourceResolver({ stdin: io.stdin });
      const authorizerConfiguration = parseJsonObjectFlag<AuthorizerConfiguration>(
        "authorizer-configuration",
        await source.resolveText("authorizer-configuration", flags["authorizer-configuration"]),
      );

      const input: UpdatePaymentManagerInput = {
        paymentManagerId: flags.id,
        ...(flags.description !== undefined ? { description: flags.description } : {}),
        ...(flags["authorizer-type"] ? { authorizerType: flags["authorizer-type"] } : {}),
        ...(authorizerConfiguration ? { authorizerConfiguration } : {}),
        ...(flags["role-arn"] ? { roleArn: flags["role-arn"] } : {}),
        ...(flags["kms-key-arn"] ? { kmsKeyArn: flags["kms-key-arn"] } : {}),
        ...(flags["client-token"] ? { clientToken: flags["client-token"] } : {}),
      };

      ctx
        .require(JsonRendererKey)
        .renderJson(await core.payment.updatePaymentManager(input, coreOptsFromCtx(ctx)));
    },
  });
