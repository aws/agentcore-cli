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
      flag("memory", "the ID of the Memory", z.string()),
      flag("record-id", "the ID of the Memory record", z.string()),
    ],
    handle: async (ctx, flags) => {
      const response = await core.memory.getMemoryRecord(
        {
          memoryId: flags.memory,
          memoryRecordId: flags["record-id"],
        },
        coreOptsFromCtx(ctx),
      );

      ctx.require(JsonRendererKey).renderJson(response);
    },
  });
