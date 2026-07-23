import z from "zod";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export const createDeleteEvaluatorHandler = (core: Core) =>
  createHandler({
    name: "delete",
    description: "delete an evaluator by id",
    flags: [
      flag("id", "the ID of the evaluator to delete", z.string().optional()),
      // This branch is headless/JSON only (no TUI prompt yet), so confirmation is
      // required up front. `-y` shorthand is not wired: the router flag layer only
      // supports long option names today.
      flag("yes", "confirm deletion (required in non-interactive mode)", z.boolean().optional()),
    ],
    handle: async (ctx, flags) => {
      if (!flags["id"]) throw new TypeError("required option '--id <id>' not specified");
      if (!flags["yes"]) {
        throw new TypeError("refusing to delete without confirmation; pass '--yes' to proceed");
      }

      ctx
        .require(JsonRendererKey)
        .renderJson(await core.eval.deleteEvaluator(flags["id"], coreOptsFromCtx(ctx)));
    },
  });
