import z from "zod";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { AppIO, Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";
import { readSourceText } from "../../../source";

export const createUpdateApiKeyCredentialProviderHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "update",
    description: "update an API key credential provider",
    flags: [
      flag("name", "the name of the API key credential provider", z.string().optional()),
      flag("api-key", "the new API key value (inline, file://path, or -)", z.string().optional(), {
        sensitive: true,
      }),
      flag("api-key-secret-arn", "existing Secrets Manager secret ARN", z.string().optional()),
      flag(
        "api-key-secret-json-key",
        "JSON key containing the API key in the secret",
        z.string().optional(),
      ),
    ],
    handle: async (ctx, flags) => {
      if (!flags.name) {
        throw new TypeError("required option '--name <name>' not specified");
      }

      const hasApiKey = flags["api-key"] !== undefined;
      const hasSecretArn = flags["api-key-secret-arn"] !== undefined;
      const hasSecretJsonKey = flags["api-key-secret-json-key"] !== undefined;

      if (hasApiKey && (hasSecretArn || hasSecretJsonKey)) {
        throw new TypeError(
          "--api-key and --api-key-secret-arn/--api-key-secret-json-key are mutually exclusive",
        );
      }
      if (!hasApiKey && !hasSecretArn) {
        throw new TypeError(
          "either --api-key or --api-key-secret-arn and --api-key-secret-json-key are required",
        );
      }
      if (hasSecretArn !== hasSecretJsonKey) {
        throw new TypeError(
          "--api-key-secret-arn and --api-key-secret-json-key must be specified together",
        );
      }

      const apiKey = hasApiKey ? await readSourceText(flags["api-key"]!, io.stdin) : undefined;

      const apiKeySecretConfig = hasSecretArn
        ? { secretId: flags["api-key-secret-arn"]!, jsonKey: flags["api-key-secret-json-key"]! }
        : undefined;

      const apiKeySecretSource = hasApiKey ? "MANAGED" : "EXTERNAL";

      ctx.require(JsonRendererKey).renderJson(
        await core.identity.updateApiKeyCredentialProvider(
          {
            name: flags.name,
            apiKey,
            apiKeySecretConfig,
            apiKeySecretSource: apiKeySecretSource as any,
          },
          coreOptsFromCtx(ctx),
        ),
      );
    },
  });
