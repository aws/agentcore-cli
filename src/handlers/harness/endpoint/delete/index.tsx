import z from "zod";
import { createHandler, flag } from "../../../../router";
import type { Core } from "../../../types.tsx";
import { coreOptsFromCtx } from "../../../utils.tsx";
import { JsonRendererKey } from "../../../../tui";

export const createDeleteEndpointHandler = (core: Core) =>
  createHandler({
    name: "delete",
    description: "delete a harness endpoint",
    flags: [
      flag("id", "the ID of the harness", z.string().min(1).max(48)),
      flag("qualifier", "the endpoint name (qualifier)", z.string().min(1)),
    ],
    handle: async (ctx, flags) => {
      const response = await core.harness.deleteHarnessEndpoint(
        {
          harnessId: flags["id"],
          endpointName: flags["qualifier"],
        },
        coreOptsFromCtx(ctx),
      );
      ctx.require(JsonRendererKey).renderJson(response);
    },
  });

export { HarnessDeleteEndpointScreen } from "./screen.tsx";
