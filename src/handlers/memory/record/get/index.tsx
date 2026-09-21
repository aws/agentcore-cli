import z from "zod";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export const createGetMemoryRecordHandler = (core: Core) =>
  createHandler({
    name: "get",
    description: "get an AgentCore Memory record",
    flags: [
      flag("id", "the ID of the Memory", z.string().min(1)),
      flag("record-id", "the ID of the Memory record", z.string().min(1)),
    ],
    handle: async (ctx, flags) => {
      const response = await core.memory.getMemoryRecord(
        {
          memoryId: flags.id,
          memoryRecordId: flags["record-id"],
        },
        coreOptsFromCtx(ctx),
      );

      ctx.require(JsonRendererKey).renderJson(response);
    },
  });
