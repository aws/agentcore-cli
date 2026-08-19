import z from "zod";
import { InputValidationError } from "../../../../errors";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";
import { parseMemoryMetadataFilters } from "../../metadataFilters";

export const createListMemoryRecordsHandler = (core: Core) =>
  createHandler({
    name: "list",
    description: "list AgentCore Memory records",
    flags: [
      flag("id", "the ID of the Memory", z.string().optional()),
      flag("namespace", "filter by namespace prefix", z.string().optional()),
      flag("namespace-path", "filter by namespace hierarchy", z.string().optional()),
      flag("strategy-id", "filter by Memory strategy ID", z.string().optional()),
      flag("metadata-filters", "Memory record metadata filters as JSON", z.string().optional()),
      flag("max-results", "maximum number of records to return", z.number().optional()),
      flag("next-token", "pagination token returned by a previous request", z.string().optional()),
    ],
    handle: async (ctx, flags) => {
      if (!flags.id) {
        throw new InputValidationError("required option '--id <id>' not specified");
      }

      const hasNamespace = flags.namespace !== undefined;
      const hasNamespacePath = flags["namespace-path"] !== undefined;
      if (hasNamespace === hasNamespacePath) {
        throw new InputValidationError(
          "exactly one of '--namespace' or '--namespace-path' must be specified",
        );
      }

      const metadataFilters = parseMemoryMetadataFilters(flags["metadata-filters"]);
      const response = await core.memory.listMemoryRecords(
        {
          memoryId: flags.id,
          namespace: flags.namespace,
          namespacePath: flags["namespace-path"],
          memoryStrategyId: flags["strategy-id"],
          metadataFilters,
          maxResults: flags["max-results"],
          nextToken: flags["next-token"],
        },
        coreOptsFromCtx(ctx),
      );

      ctx.require(JsonRendererKey).renderJson(response);
    },
  });
