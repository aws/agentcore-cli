import z from "zod";
import { createHandler, flag } from "../../../../router";
import { InputValidationError } from "../../../../errors";
import { JsonRendererKey } from "../../../../tui";
import { withUserCancellation } from "../../../../runnable";
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
      const datasetId = flags["id"];

      const filePath = flags["file-path"];
      if (!filePath) {
        ctx
          .require(JsonRendererKey)
          .renderJson(
            await core.eval.getDataset(datasetId, flags["version"], coreOptsFromCtx(ctx)),
          );
        return;
      }

      // --file-path downloads the contents via the presigned download URL in metadata
      const response = await withUserCancellation((signal) =>
        core.eval.downloadDataset(
          datasetId,
          flags["version"],
          filePath,
          coreOptsFromCtx(ctx),
          signal,
        ),
      );
      // file is written in addition to the normal metadata output
      ctx.require(JsonRendererKey).renderJson({ ...response, filePath });
    },
  });
