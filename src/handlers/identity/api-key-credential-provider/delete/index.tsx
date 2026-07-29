import z from "zod";
import { InputValidationError } from "../../../../errors";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export const createDeleteApiKeyCredentialProviderHandler = (core: Core) =>
  createHandler({
    name: "delete",
    description: "delete an API key credential provider",
    flags: [flag("name", "the name of the API key credential provider", z.string().optional())],
    handle: async (ctx, flags) => {
      if (!flags.name) {
        throw new InputValidationError("required option '--name <name>' not specified");
      }

      ctx
        .require(JsonRendererKey)
        .renderJson(
          await core.identity.deleteApiKeyCredentialProvider(flags.name, coreOptsFromCtx(ctx)),
        );
    },
  });
