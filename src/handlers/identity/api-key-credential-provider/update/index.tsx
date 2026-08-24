import z from "zod";
import { InputValidationError } from "../../../../errors";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import type { AppIO } from "../../../../io";
import { coreOptsFromCtx } from "../../../utils";
import { SourceResolver } from "../../../../io";
import { parseSecretReference } from "../../parser";

export const createUpdateApiKeyCredentialProviderHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "update",
    description: "update an API key credential provider",
    flags: [
      flag("name", "the name of the API key credential provider", z.string().optional()),
      flag(
        "api-key",
        "the new API key (file://path or - for stdin; inline values are rejected)",
        z.string().optional(),
        { sensitive: true },
      ),
      flag(
        "api-key-secret-reference",
        'external secret reference JSON: {"secretId":"<arn>","jsonKey":"<key>"}',
        z.string().optional(),
      ),
    ],
    handle: async (ctx, flags) => {
      if (!flags.name) {
        throw new InputValidationError("required option '--name <name>' not specified");
      }
      const hasApiKey = flags["api-key"] !== undefined;
      const hasSecretRef = flags["api-key-secret-reference"] !== undefined;

      if (hasApiKey && hasSecretRef) {
        throw new InputValidationError(
          "--api-key and --api-key-secret-reference are mutually exclusive",
        );
      }
      if (!hasApiKey && !hasSecretRef) {
        throw new InputValidationError(
          "either --api-key or --api-key-secret-reference is required",
        );
      }

      const opts = coreOptsFromCtx(ctx);
      const existing = await core.identity.getApiKeyCredentialProvider(flags.name, opts);
      const existingSource = existing.apiKeySecretSource;

      if (hasApiKey && existingSource === "EXTERNAL") {
        throw new InputValidationError(
          "this provider uses an external secret; use --api-key-secret-reference to update it",
        );
      }
      if (hasSecretRef && existingSource === "MANAGED") {
        throw new InputValidationError(
          "this provider uses a managed secret; use --api-key to update it",
        );
      }

      const resolver = new SourceResolver({ stdin: io.stdin });
      const apiKey = await resolver.resolveSecret("api-key", flags["api-key"]);
      const apiKeySecretConfig = hasSecretRef
        ? parseSecretReference("api-key-secret-reference", flags["api-key-secret-reference"]!)
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
