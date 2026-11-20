import z from "zod";
import { createHandler, flag } from "../../../../router";
import { InputValidationError } from "../../../../errors";
import { JsonRendererKey } from "../../../../tui";
import { SourceResolver, type AppIO } from "../../../../io";
import type { Core } from "../../../types";
import { coreOptsFromCtx, parseTags, tagsFlag } from "../../../utils";
import { looksLikePath, resolveDatasetSource, sourceFlag } from "../source";

export const createCreateDatasetHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "create",
    description: "create a dataset, optionally seeded from JSONL examples",
    flags: [
      flag("name", "the name of the dataset", z.string().min(1)),
      sourceFlag,
      flag("description", "a description of the dataset", z.string().optional()),
      flag("kms-key-arn", "customer managed KMS key ARN for dataset data", z.string().optional()),
      tagsFlag(),
    ],
    handle: async (ctx, flags) => {
      const source = new SourceResolver({ stdin: io.stdin });
      const datasetSource =
        flags["source"] === undefined
          ? undefined
          : await resolveDatasetSource(flags["source"], source).catch((error: unknown) => {
              // A bare path is read as inline JSONL and dies on line 1. Name the
              // documented spelling instead of surfacing a parse error.
              if (error instanceof InputValidationError && looksLikePath(flags["source"]!)) {
                throw new InputValidationError(
                  `'--source' could not be read as JSONL; to read a local file pass ` +
                    `'file://${flags["source"]}'`,
                  { cause: error },
                );
              }
              throw error;
            });

      const response = await core.eval.createDataset(
        {
          datasetName: flags["name"],
          source: datasetSource,
          // Removed from the GA API; delete this line when @aws-sdk drops the member.
          schemaType: undefined,
          description: flags["description"],
          kmsKeyArn: flags["kms-key-arn"],
          tags: parseTags(flags["tags"]),
        },
        coreOptsFromCtx(ctx),
      );
      ctx.require(JsonRendererKey).renderJson(response);
    },
  });
