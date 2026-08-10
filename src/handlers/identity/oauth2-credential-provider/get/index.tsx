import z from "zod";
import { InputValidationError } from "../../../../errors";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export const createGetOauth2CredentialProviderHandler = (core: Core) =>
  createHandler({
    name: "get",
    description: "get an OAuth2 credential provider",
    flags: [flag("name", "the name of the OAuth2 credential provider", z.string().optional())],
    handle: async (ctx, flags) => {
      if (!flags.name) {
        throw new InputValidationError("required option '--name <name>' not specified");
      }

      ctx
        .require(JsonRendererKey)
        .renderJson(
          await core.identity.getOauth2CredentialProvider(flags.name, coreOptsFromCtx(ctx)),
        );
    },
  });
