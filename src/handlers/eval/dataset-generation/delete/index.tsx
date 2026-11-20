import z from "zod";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export const createDeleteDatasetGenerationHandler = (core: Core) =>
  createHandler({
    name: "delete",
    description: "delete a generation record (its examples stay in the DRAFT)",
    flags: [
      flag("dataset-id", "the ID of the dataset", z.string().min(1)),
      flag("id", "the ID of the generation", z.string().min(1)),
    ],
    handle: async (ctx, flags) => {
      ctx
        .require(JsonRendererKey)
        .renderJson(
          await core.eval.deleteDatasetGeneration(
            flags["dataset-id"],
            flags["id"],
            coreOptsFromCtx(ctx),
          ),
        );
    },
  });
