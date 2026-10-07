import z from "zod";
import { createHandler, flag } from "../../../../router";
import type { Core } from "../../../types.tsx";
import { coreOptsFromCtx, parseTags } from "../../../utils.tsx";
import { JsonRendererKey } from "../../../../tui";

export const createCreateEndpointHandler = (core: Core) =>
  createHandler({
    name: "create",
    description: "create a harness endpoint",
    flags: [
      flag("id", "the ID of the harness", z.string().min(1).max(48)),
      flag("name", "the name of the endpoint", z.string().min(1)),
      flag(
        "target-version",
        "the harness version the endpoint points to (default latest)",
        z.string().optional(),
      ),
      flag(
        "tags",
        "tags as repeated key=value entries or a JSON object",
        z.array(z.string()).optional(),
      ),
    ],
    handle: async (ctx, flags) => {
      const response = await core.harness.createHarnessEndpoint(
        {
          harnessId: flags["id"],
          endpointName: flags["name"],
          targetVersion: flags["target-version"],
          tags: parseTags(flags["tags"]),
        },
        coreOptsFromCtx(ctx),
      );
      ctx.require(JsonRendererKey).renderJson(response);
    },
  });

export { HarnessCreateEndpointScreen } from "./screen.tsx";
