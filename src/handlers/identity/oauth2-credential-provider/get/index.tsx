import z from "zod";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export const createGetOauth2CredentialProviderHandler = (core: Core) =>
  createHandler({
    name: "get",
    description: "get an OAuth2 credential provider",
    flags: [flag("name", "the name of the OAuth2 credential provider", z.string().min(1))],
    handle: async (ctx, flags) => {
      ctx
        .require(JsonRendererKey)
        .renderJson(
          await core.identity.getOauth2CredentialProvider(flags.name, coreOptsFromCtx(ctx)),
        );
    },
  });
