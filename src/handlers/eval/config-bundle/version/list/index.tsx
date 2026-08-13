import z from "zod";
import { InputValidationError } from "../../../../../errors";
import { createHandler, flag } from "../../../../../router";
import { JsonRendererKey } from "../../../../../tui";
import type { Core } from "../../../../types";
import { coreOptsFromCtx } from "../../../../utils";

export const createListConfigBundleVersionsHandler = (core: Core) =>
  createHandler({
    name: "list",
    description: "list immutable versions of a configuration bundle",
    flags: [
      flag("id", "the ID of the configuration bundle", z.string().optional()),
      flag("next-token", "pagination token returned by a previous request", z.string().optional()),
      flag("max-results", "maximum number of items to return", z.number().optional()),
    ],
    handle: async (ctx, flags) => {
      if (!flags["id"]) {
        throw new InputValidationError("required option '--id <id>' not specified");
      }

      ctx
        .require(JsonRendererKey)
        .renderJson(
          await core.eval.listConfigurationBundleVersions(
            flags["id"],
            flags["next-token"],
            flags["max-results"],
            coreOptsFromCtx(ctx),
          ),
        );
    },
  });
