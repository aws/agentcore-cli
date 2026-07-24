import z from "zod";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { AppIO, Core } from "../../../types";
import { coreOptsFromCtx, parseTags } from "../../../utils";
import { readSourceText } from "../../../source";
import { parseSecretReference } from "../parser";

export const createCreateApiKeyCredentialProviderHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "create",
    description: "create an API key credential provider",
    flags: [
      flag("name", "the name of the API key credential provider", z.string().optional()),
      flag("api-key", "the API key value (inline, file://path, or -)", z.string().optional(), {
        sensitive: true,
      }),
      flag(
        "api-key-secret-reference",
        'external secret reference JSON: {"secretId":"<arn>","jsonKey":"<key>"}',
        z.string().optional(),
      ),
      flag("tags", "tags as key=value (repeatable) or JSON object", z.array(z.string()).optional()),
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

      const apiKey = hasApiKey ? await readSourceText(flags["api-key"]!, io.stdin) : undefined;
      const apiKeySecretConfig = hasSecretRef
        ? parseSecretReference(flags["api-key-secret-reference"]!)
        : undefined;
      const apiKeySecretSource = hasApiKey ? "MANAGED" : "EXTERNAL";
      const tags = parseTags(flags.tags);

      ctx.require(JsonRendererKey).renderJson(
        await core.identity.createApiKeyCredentialProvider(
          {
            name: flags.name,
            apiKey,
            apiKeySecretConfig,
            apiKeySecretSource: apiKeySecretSource as any,
            tags,
          },
          coreOptsFromCtx(ctx),
        ),
      );
    },
  });
