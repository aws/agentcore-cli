import z from "zod";
import { createHandler, flag } from "../../../../router";
import type { Core } from "../../../types.tsx";
import { coreOptsFromCtx } from "../../../utils.tsx";
import { JsonRendererKey } from "../../../../tui";

export const createListVersionsHandler = (core: Core) =>
  createHandler({
    name: "list",
    description: "list a harness's versions",
    flags: [
      flag("id", "the ID of the harness", z.string().min(1).max(48)),
      flag("next-token", "next token to use on paginated", z.string().optional()),
      flag("max-results", "max number of items to return", z.number().optional()),
    ],
    handle: async (ctx, flags) => {
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
