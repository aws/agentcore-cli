import z from "zod";
import { createHandler, flag } from "../../../../router";
import { InputValidationError } from "../../../../errors";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export const createGetDatasetHandler = (core: Core) =>
  createHandler({
    name: "get",
    description: "get a dataset's metadata, optionally downloading its examples",
    flags: [
      flag("id", "the ID of the dataset", z.string().optional()),
      flag(
        "version",
        "the version to retrieve (DRAFT or a version number, default DRAFT)",
        z.string().optional(),
      ),
      flag(
        "file-path",
        "write the version's examples to this path as JSONL, in addition to printing metadata",
        z.string().optional(),
      ),
    ],
    handle: async (ctx, flags) => {
      if (!flags["id"]) throw new InputValidationError("required option '--id <id>' not specified");

      const filePath = flags["file-path"];
      if (!filePath) {
        ctx
          .require(JsonRendererKey)
          .renderJson(
            await core.eval.getDataset(flags["id"], flags["version"], coreOptsFromCtx(ctx)),
          );
        return;
      }

      // --file-path downloads the contents via the presigned download URL in metadata
      const controller = new AbortController();
      const interrupt = () => controller.abort();
      process.once("SIGINT", interrupt);
      try {
        const response = await core.eval.downloadDataset(
          flags["id"],
          flags["version"],
          filePath,
          coreOptsFromCtx(ctx),
          controller.signal,
        );
        // file is written in addition to the normal metadata output
        ctx.require(JsonRendererKey).renderJson(response);
      } finally {
        process.removeListener("SIGINT", interrupt);
      }
    },
  });
