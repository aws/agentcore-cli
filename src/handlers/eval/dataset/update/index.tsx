import z from "zod";
import { createHandler, flag } from "../../../../router";
import { InputValidationError } from "../../../../errors";
import type { AppIO } from "../../../../io";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export const createUpdateDatasetHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "update",
    description: "update a dataset DRAFT from a local JSONL file",
    flags: [
      flag("id", "the ID of the dataset to update", z.string().optional()),
      flag("file-path", "local JSONL file to reconcile into the DRAFT", z.string().optional()),
    ],
    handle: async (ctx, flags) => {
      if (!flags["id"]) throw new InputValidationError("required option '--id <id>' not specified");
      if (!flags["file-path"]) {
        throw new InputValidationError("required option '--file-path <file-path>' not specified");
      }

      const controller = new AbortController();
      const interrupt = () => controller.abort();
      process.once("SIGINT", interrupt);
      try {
        ctx
          .require(JsonRendererKey)
          .renderJson(
            await core.eval.updateDatasetExamples(
              flags["id"],
              flags["file-path"],
              coreOptsFromCtx(ctx),
              controller.signal,
              (event) => io.stderr.write(`${event.message}\n`),
            ),
          );
      } finally {
        process.removeListener("SIGINT", interrupt);
      }
    },
  });
