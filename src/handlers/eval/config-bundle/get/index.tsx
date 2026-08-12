import z from "zod";
import { InputValidationError } from "../../../../errors";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export const createGetConfigBundleHandler = (core: Core) =>
  createHandler({
    name: "get",
    description: "get the latest or a specific configuration bundle version",
    flags: [
      flag("id", "the ID of the configuration bundle", z.string().optional()),
      flag("version", "the immutable version ID to retrieve", z.string().optional()),
      flag(
        "branch-name",
        "branch used when retrieving the latest version",
        z.string().default("mainline"),
      ),
    ],
    handle: async (ctx, flags) => {
      if (!flags["id"]) {
        throw new InputValidationError("required option '--id <id>' not specified");
      }

      ctx
        .require(JsonRendererKey)
        .renderJson(
          await core.eval.getConfigurationBundle(
            flags["id"],
            flags["version"],
            flags["branch-name"],
            coreOptsFromCtx(ctx),
          ),
        );
    },
  });
