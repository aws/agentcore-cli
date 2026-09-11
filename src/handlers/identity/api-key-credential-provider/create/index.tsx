import z from "zod";
import { InputValidationError } from "../../../../errors";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import type { AppIO } from "../../../../io";
import { assertMutuallyExclusiveFlags, coreOptsFromCtx, parseTags } from "../../../utils";
import { SourceResolver } from "../../../../io";
import { parseSecretReference } from "../../parser";

export const createCreateApiKeyCredentialProviderHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "create",
    description: "create an API key credential provider",
    flags: [
      flag("name", "the name of the API key credential provider", z.string().optional()),
      flag(
        "api-key",
        "the API key (file://path or - for stdin; inline values are rejected)",
        z.string().optional(),
        { sensitive: true },
      ),
      flag(
        "api-key-secret-reference",
        'external secret reference JSON: {"secretId":"<arn>","jsonKey":"<key>"}',
        z.string().optional(),
      ),
      flag("tags", "tags as key=value (repeatable) or JSON object", z.array(z.string()).optional()),
    ],
    handle: async (ctx, flags) => {
      if (!flags.name) {
        throw new InputValidationError("required option '--name <name>' not specified");
      }
      assertMutuallyExclusiveFlags(flags, ["api-key", "api-key-secret-reference"], {
        exactlyOne: true,
      });
      const hasApiKey = flags["api-key"] !== undefined;
      const hasSecretRef = flags["api-key-secret-reference"] !== undefined;

      const resolver = new SourceResolver({ stdin: io.stdin });
      const apiKey = await resolver.resolveSecret("api-key", flags["api-key"]);
      const apiKeySecretConfig = hasSecretRef
        ? parseSecretReference("api-key-secret-reference", flags["api-key-secret-reference"]!)
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
