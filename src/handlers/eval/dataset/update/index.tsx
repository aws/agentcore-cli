import z from "zod";
import { createHandler, flag } from "../../../../router";
import type { AppIO } from "../../../../io";
import { JsonRendererKey } from "../../../../tui";
import { withUserCancellation } from "../../../../runnable";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export const createUpdateDatasetHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "update",
    description: "update a dataset DRAFT from a local JSONL file",
    flags: [
      flag("id", "the ID of the dataset to update", z.string().min(1)),
      flag("file-path", "local JSONL file to reconcile into the DRAFT", z.string().min(1)),
    ],
    handle: async (ctx, flags) => {
      const datasetId = flags["id"];
      const filePath = flags["file-path"];

      ctx
        .require(JsonRendererKey)
        .renderJson(
          await withUserCancellation((signal) =>
            core.eval.updateDatasetExamples(
              datasetId,
              filePath,
              coreOptsFromCtx(ctx),
              signal,
              (event) => io.stderr.write(`${event.message}\n`),
            ),
          ),
        );
    },
  });
