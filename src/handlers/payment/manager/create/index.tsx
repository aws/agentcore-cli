import type { AuthorizerConfiguration } from "@aws-sdk/client-bedrock-agentcore-control";
import z from "zod";
import { InputValidationError } from "../../../../errors";
import { type AppIO, SourceResolver } from "../../../../io";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx, parseJsonObjectFlag, parseTags } from "../../../utils";
import type { CreatePaymentManagerInput } from "../../types";

export const createCreatePaymentManagerHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "create",
    description: "create a payment manager (auto-provisions a service role if none given)",
    flags: [
      flag(
        "name",
        "the payment manager name (letters and digits, up to 48 characters)",
        z.string().optional(),
      ),
      flag("description", "payment manager description", z.string().optional()),
      flag(
        "authorizer-type",
        "how agents authenticate to the data plane: AWS_IAM (default) or CUSTOM_JWT",
        z.enum(["AWS_IAM", "CUSTOM_JWT"]).default("AWS_IAM"),
      ),
      flag(
        "authorizer-configuration",
        "CUSTOM_JWT configuration (JSON AuthorizerConfiguration; inline, file://<path>, or - for stdin)",
        z.string().optional(),
      ),
      flag(
        "role-arn",
        "IAM role the Payments service assumes; a default service role is created when omitted",
        z.string().min(1).optional(),
      ),
      flag(
        "kms-key-arn",
        "customer managed KMS key ARN for encrypting sensitive data at rest",
        z.string().min(1).optional(),
      ),
      flag("tags", "tags as key=value (repeatable) or JSON object", z.array(z.string()).optional()),
      flag("client-token", "idempotency token", z.string().optional()),
    ],
    handle: async (ctx, flags) => {
      // Required at runtime but declared optional so that a bare invocation can
      // fall through to the TUI once a screen exists.
      if (!flags.name) {
        throw new InputValidationError("required option '--name <name>' not specified");
      }
      if (
        flags["authorizer-type"] === "CUSTOM_JWT" &&
        flags["authorizer-configuration"] === undefined
      ) {
        throw new InputValidationError("CUSTOM_JWT requires --authorizer-configuration");
      }
      if (
        flags["authorizer-type"] !== "CUSTOM_JWT" &&
        flags["authorizer-configuration"] !== undefined
      ) {
        throw new InputValidationError("--authorizer-configuration is valid only with CUSTOM_JWT");
      }

      const source = new SourceResolver({ stdin: io.stdin });
      const authorizerConfiguration = parseJsonObjectFlag<AuthorizerConfiguration>(
        "authorizer-configuration",
        await source.resolveText("authorizer-configuration", flags["authorizer-configuration"]),
      );
      const tags = parseTags(flags.tags);

      const input: CreatePaymentManagerInput = {
        name: flags.name,
        authorizerType: flags["authorizer-type"],
        ...(flags.description ? { description: flags.description } : {}),
        ...(authorizerConfiguration ? { authorizerConfiguration } : {}),
        ...(flags["role-arn"] ? { roleArn: flags["role-arn"] } : {}),
        ...(flags["kms-key-arn"] ? { kmsKeyArn: flags["kms-key-arn"] } : {}),
        ...(tags ? { tags } : {}),
        ...(flags["client-token"] ? { clientToken: flags["client-token"] } : {}),
      };

      ctx
        .require(JsonRendererKey)
        .renderJson(await core.payment.createPaymentManager(input, coreOptsFromCtx(ctx)));
    },
  });
