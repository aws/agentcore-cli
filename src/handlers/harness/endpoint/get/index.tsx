import z from "zod";
import { createHandler, flag } from "../../../../router";
import type { Core } from "../../../types.tsx";
import { coreOptsFromCtx } from "../../../utils.tsx";
import { JsonRendererKey } from "../../../../tui";

export const createGetEndpointHandler = (core: Core) =>
  createHandler({
    name: "get",
    description: "get a harness endpoint",
    flags: [
      flag("id", "the ID of the harness", z.string().min(1).max(48)),
      flag("qualifier", "the endpoint name (qualifier)", z.string().min(1)),
    ],
    handle: async (ctx, flags) => {
      const endpoint = await core.harness.getHarnessEndpoint(
        flags["id"],
        flags["qualifier"],
        coreOptsFromCtx(ctx),
      );
      ctx.require(JsonRendererKey).renderJson(endpoint);
    },
  });

export { HarnessGetEndpointScreen } from "./screen.tsx";
