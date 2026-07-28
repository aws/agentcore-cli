import z from "zod";
import { createHandler, flag } from "../../../../router";
import type { Core } from "../../../types.tsx";
import { coreOptsFromCtx } from "../../../utils.tsx";
import { JsonRendererKey } from "../../../../tui";
import { InputValidationError } from "../../../../errors";

export const createGetEndpointHandler = (core: Core) =>
  createHandler({
    name: "get",
    description: "get a harness endpoint",
    flags: [
      flag("id", "the ID of the harness", z.string().max(48).optional()),
      flag("qualifier", "the endpoint name (qualifier)", z.string().optional()),
    ],
    handle: async (ctx, flags) => {
      if (!flags["id"]) {
        throw new InputValidationError("required option '--id <id>' not specified");
      }
      if (!flags["qualifier"]) {
        throw new InputValidationError("required option '--qualifier <qualifier>' not specified");
      }

      const endpoint = await core.harness.getHarnessEndpoint(
        flags["id"],
        flags["qualifier"],
        coreOptsFromCtx(ctx),
      );
      ctx.require(JsonRendererKey).renderJson(endpoint);
    },
  });

export { HarnessGetEndpointScreen } from "./screen.tsx";
