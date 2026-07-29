import z from "zod";
import { createHandler, flag } from "../../../../router";
import type { Core } from "../../../types.tsx";
import { coreOptsFromCtx } from "../../../utils.tsx";
import { JsonRendererKey } from "../../../../tui";
import { InputValidationError } from "../../../../errors";

export const createUpdateEndpointHandler = (core: Core) =>
  createHandler({
    name: "update",
    description: "update a harness endpoint",
    flags: [
      flag("id", "the ID of the harness", z.string().max(48).optional()),
      flag("qualifier", "the endpoint name (qualifier)", z.string().optional()),
      flag("target-version", "the harness version the endpoint points to", z.string().optional()),
      flag("client-token", "idempotency token", z.string().optional()),
    ],
    handle: async (ctx, flags) => {
      // Required at runtime but declared optional so that a bare
      // `harness endpoint update` falls through to the TUI middleware instead.
      if (!flags["id"]) {
        throw new InputValidationError("required option '--id <id>' not specified");
      }
      if (!flags["qualifier"]) {
        throw new InputValidationError("required option '--qualifier <qualifier>' not specified");
      }

      const response = await core.harness.updateHarnessEndpoint(
        {
          harnessId: flags["id"],
          endpointName: flags["qualifier"],
          targetVersion: flags["target-version"],
          clientToken: flags["client-token"],
        },
        coreOptsFromCtx(ctx),
      );
      ctx.require(JsonRendererKey).renderJson(response);
    },
  });

export { HarnessUpdateEndpointScreen } from "./screen.tsx";
