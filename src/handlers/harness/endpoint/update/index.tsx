import z from "zod";
import { createHandler, flag } from "../../../../router";
import type { Core } from "../../../types.tsx";
import { coreOptsFromCtx } from "../../../utils.tsx";
import { JsonRendererKey } from "../../../../tui";

export const createUpdateEndpointHandler = (core: Core) =>
  createHandler({
    name: "update",
    description: "update a harness endpoint",
    flags: [
      flag("id", "the ID of the harness", z.string().min(1).max(48)),
      flag("qualifier", "the endpoint name (qualifier)", z.string().min(1)),
      flag("target-version", "the harness version the endpoint points to", z.string().optional()),
    ],
    handle: async (ctx, flags) => {
      const response = await core.harness.updateHarnessEndpoint(
        {
          harnessId: flags["id"],
          endpointName: flags["qualifier"],
          targetVersion: flags["target-version"],
        },
        coreOptsFromCtx(ctx),
      );
      ctx.require(JsonRendererKey).renderJson(response);
    },
  });

export { HarnessUpdateEndpointScreen } from "./screen.tsx";
