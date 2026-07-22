import z from "zod";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export const createUpdateApiKeyCredentialProviderHandler = (core: Core) =>
  createHandler({
    name: "update",
    description: "update an API key credential provider",
    flags: [
      flag("name", "the name of the API key credential provider", z.string().optional()),
      flag("api-key", "the new API key value", z.string().optional()),
    ],
    handle: async (ctx, flags) => {
      if (!flags.name) {
        throw new TypeError("required option '--name <name>' not specified");
      }
      if (!flags["api-key"]) {
        throw new TypeError("required option '--api-key <api-key>' not specified");
      }

      ctx
        .require(JsonRendererKey)
        .renderJson(
          await core.identity.updateApiKeyCredentialProvider(
            flags.name,
            flags["api-key"],
            coreOptsFromCtx(ctx),
          ),
        );
    },
  });
