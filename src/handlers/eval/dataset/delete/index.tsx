import z from "zod";
import { createHandler, flag } from "../../../../router";
import { InputValidationError } from "../../../../errors";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export const createDeleteDatasetHandler = (core: Core) =>
  createHandler({
    name: "delete",
    description: "delete a dataset, or one of its published versions",
    flags: [
      flag("id", "the ID of the dataset to delete", z.string().optional()),
      flag(
        "version",
        "delete only this published version, leaving the dataset in place; " +
          "omit to delete the entire dataset",
        z.string().optional(),
      ),
    ],
    handle: async (ctx, flags) => {
      if (!flags["id"]) throw new InputValidationError("required option '--id <id>' not specified");

      // Deletion is async: the response reports DELETING
      ctx
        .require(JsonRendererKey)
        .renderJson(
          await core.eval.deleteDataset(flags["id"], flags["version"], coreOptsFromCtx(ctx)),
        );
    },
  });
