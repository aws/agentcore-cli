import z from "zod";
import { createHandler, flag } from "../../../../router";
import type { Core } from "../../../types.tsx";
import { coreOptsFromCtx } from "../../../utils.tsx";
import { JsonRendererKey } from "../../../../tui";
import { InputValidationError } from "../../../../errors";

export const createListVersionsHandler = (core: Core) =>
  createHandler({
    name: "list",
    description: "list a harness's versions",
    flags: [
      flag("id", "the ID of the harness", z.string().max(48).optional()),
      flag("next-token", "next token to use on paginated", z.string().optional()),
      flag("max-results", "max number of items to return", z.number().optional()),
    ],
    handle: async (ctx, flags) => {
      if (!flags["id"]) {
        throw new InputValidationError("required option '--id <id>' not specified");
      }

      const versions = await core.harness.listHarnessVersions(
        flags["id"],
        flags["next-token"],
        flags["max-results"],
        coreOptsFromCtx(ctx),
      );
      ctx.require(JsonRendererKey).renderJson(versions);
    },
  });

export { HarnessListVersionsScreen } from "./screen.tsx";
