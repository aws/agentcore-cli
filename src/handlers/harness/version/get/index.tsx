import z from "zod";
import { createHandler, flag } from "../../../../router";
import type { Core } from "../../../types.tsx";
import { coreOptsFromCtx } from "../../../utils.tsx";
import { JsonRendererKey } from "../../../../tui";
import { InputValidationError } from "../../../../errors";

export const createGetVersionHandler = (core: Core) =>
  createHandler({
    name: "get",
    description: "get a specific version of a harness",
    flags: [
      flag("id", "the ID of the harness", z.string().max(48).optional()),
      flag("version", "the harness version to get", z.string().optional()),
    ],
    handle: async (ctx, flags) => {
      if (!flags["id"]) {
        throw new InputValidationError("required option '--id <id>' not specified");
      }
      if (!flags["version"]) {
        throw new InputValidationError("required option '--version <version>' not specified");
      }

      const harness = await core.harness.getHarnessVersion(
        flags["id"],
        flags["version"],
        coreOptsFromCtx(ctx),
      );
      ctx.require(JsonRendererKey).renderJson(harness);
    },
  });

export { HarnessGetVersionScreen } from "./screen.tsx";
