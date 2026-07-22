import z from "zod";
import { createHandler, flag } from "../../../router";
import { JsonRendererKey } from "../../../tui";
import type { Core } from "../../types";
import { coreOptsFromCtx } from "../../utils";
import { withoutSdkMetadata } from "../withoutSdkMetadata";

export const createGetRuntimeHandler = (core: Core) =>
  createHandler({
    name: "get",
    description: "get an AgentCore Runtime",
    flags: [flag("id", "the ID of the Runtime", z.string().optional())],
    handle: async (ctx, flags) => {
      if (!flags.id) {
        throw new TypeError("required option '--id <id>' not specified");
      }

      ctx
        .require(JsonRendererKey)
        .renderJson(
          withoutSdkMetadata(await core.runtime.getRuntime(flags.id, coreOptsFromCtx(ctx))),
        );
    },
  });
