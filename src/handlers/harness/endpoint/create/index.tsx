import z from "zod";
import { createHandler, flag } from "../../../../router";
import type { Core } from "../../../types.tsx";
import { coreOptsFromCtx, parseJsonFlag } from "../../../utils.tsx";
import { JsonRendererKey } from "../../../../tui";
import { InputValidationError } from "../../../../errors";

export const createCreateEndpointHandler = (core: Core) =>
  createHandler({
    name: "create",
    description: "create a harness endpoint",
    flags: [
      flag("id", "the ID of the harness", z.string().max(48).optional()),
      flag("name", "the name of the endpoint", z.string().optional()),
      flag(
        "target-version",
        "the harness version the endpoint points to (default latest)",
        z.string().optional(),
      ),
      flag("tags", "tags to apply (JSON object of key/value strings)", z.string().optional()),
    ],
    handle: async (ctx, flags) => {
      // Required at runtime but declared optional so that a bare
      // `harness endpoint create` falls through to the TUI middleware instead.
      if (!flags["id"]) {
        throw new InputValidationError("required option '--id <id>' not specified");
      }
      if (!flags["name"]) {
        throw new InputValidationError("required option '--name <name>' not specified");
      }

      const response = await core.harness.createHarnessEndpoint(
        {
          harnessId: flags["id"],
          endpointName: flags["name"],
          targetVersion: flags["target-version"],
          tags: parseJsonFlag<Record<string, string>>("tags", flags["tags"]),
        },
        coreOptsFromCtx(ctx),
      );
      ctx.require(JsonRendererKey).renderJson(response);
    },
  });

export { HarnessCreateEndpointScreen } from "./screen.tsx";
