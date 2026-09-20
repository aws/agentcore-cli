import z from "zod";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export const createGetApiKeyCredentialProviderHandler = (core: Core) =>
  createHandler({
    name: "get",
    description: "get an API key credential provider",
    flags: [flag("name", "the name of the API key credential provider", z.string().min(1))],
    handle: async (ctx, flags) => {
      ctx
        .require(JsonRendererKey)
        .renderJson(
          await core.identity.getApiKeyCredentialProvider(flags.name, coreOptsFromCtx(ctx)),
        );
    },
  });
