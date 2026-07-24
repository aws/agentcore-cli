import z from "zod";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { AppIO, Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";
import { readSourceText } from "../../../source";
import { parseSecretReference } from "../parser";

export const createUpdateApiKeyCredentialProviderHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "update",
    description: "update an API key credential provider",
    flags: [
      flag("name", "the name of the API key credential provider", z.string().optional()),
      flag("api-key", "the new API key value (inline, file://path, or -)", z.string().optional(), {
        sensitive: true,
      }),
      flag(
        "api-key-secret-reference",
        'external secret reference JSON: {"secretId":"<arn>","jsonKey":"<key>"}',
        z.string().optional(),
      ),
    ],
    handle: async (ctx, flags) => {
      if (!flags.name) {
        throw new TypeError("required option '--name <name>' not specified");
      }

      const hasApiKey = flags["api-key"] !== undefined;
      const hasSecretRef = flags["api-key-secret-reference"] !== undefined;

      if (hasApiKey && hasSecretRef) {
        throw new TypeError("--api-key and --api-key-secret-reference are mutually exclusive");
      }
      if (!hasApiKey && !hasSecretRef) {
        throw new TypeError("either --api-key or --api-key-secret-reference is required");
      }

      const opts = coreOptsFromCtx(ctx);
      const existing = await core.identity.getApiKeyCredentialProvider(flags.name, opts);
      const existingSource = existing.apiKeySecretSource;

      if (hasApiKey && existingSource === "EXTERNAL") {
        throw new TypeError(
          "this provider uses an external secret; use --api-key-secret-reference to update it",
        );
      }
      if (hasSecretRef && existingSource === "MANAGED") {
        throw new TypeError("this provider uses a managed secret; use --api-key to update it");
      }

      const apiKey = hasApiKey ? await readSourceText(flags["api-key"]!, io.stdin) : undefined;
      const apiKeySecretConfig = hasSecretRef
        ? parseSecretReference(flags["api-key-secret-reference"]!)
        : undefined;

      ctx.require(JsonRendererKey).renderJson(
        await core.identity.updateApiKeyCredentialProvider(
          {
            name: flags.name,
            apiKey,
            apiKeySecretConfig,
            apiKeySecretSource: existingSource,
          },
          opts,
        ),
      );
    },
  });
