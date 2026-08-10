import z from "zod";
import { createHandler, flag } from "../../../../router";
import { InputValidationError } from "../../../../errors";
import { JsonRendererKey } from "../../../../tui";
import { SourceResolver, type AppIO } from "../../../../io";
import type { Core } from "../../../types";
import { coreOptsFromCtx, parseTags } from "../../../utils";
import { SCHEMA_TYPE_ALIASES, datasetSchemaType } from "../schemaTypes";
import { looksLikePath, resolveDatasetSource, sourceFlag } from "../source";

export const createCreateDatasetHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "create",
    description: "create a dataset from JSONL examples",
    flags: [
      flag("name", "the name of the dataset", z.string().optional()),
      sourceFlag,
      flag(
        "schema-type",
        `the structure of the dataset's examples, immutable after creation (${SCHEMA_TYPE_ALIASES.join(" | ")})`,
        z.enum(SCHEMA_TYPE_ALIASES).optional(),
      ),
      flag("description", "a description of the dataset", z.string().optional()),
      flag("kms-key-arn", "customer managed KMS key ARN for dataset data", z.string().optional()),
      flag("tags", "tags as key=value (repeatable) or JSON object", z.array(z.string()).optional()),
    ],
    handle: async (ctx, flags) => {
      if (!flags["name"])
        throw new InputValidationError("required option '--name <name>' not specified");
      if (!flags["source"]) {
        throw new InputValidationError("required option '--source <source>' not specified");
      }
      if (!flags["schema-type"]) {
        throw new InputValidationError(
          "required option '--schema-type <schema-type>' not specified",
        );
      }

      const source = new SourceResolver({ stdin: io.stdin });
      const datasetSource = await resolveDatasetSource(flags["source"], source).catch(
        (error: unknown) => {
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
        },
      );

      const response = await core.eval.createDataset(
        {
          datasetName: flags["name"],
          source: datasetSource,
          schemaType: datasetSchemaType(flags["schema-type"]),
          description: flags["description"],
          kmsKeyArn: flags["kms-key-arn"],
          tags: parseTags(flags["tags"]),
        },
        coreOptsFromCtx(ctx),
      );
      ctx.require(JsonRendererKey).renderJson(response);
    },
  });
