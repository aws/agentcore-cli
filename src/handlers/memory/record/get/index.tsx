import z from "zod";
import { InputValidationError } from "../../../../errors";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import type { Core } from "../../../types";
import { coreOptsFromCtx } from "../../../utils";

export const createGetMemoryRecordHandler = (core: Core) =>
  createHandler({
    name: "get",
    description: "get an AgentCore Memory record",
    flags: [
      flag("id", "the ID of the Memory", z.string().optional()),
      flag("record-id", "the ID of the Memory record", z.string().optional()),
    ],
    handle: async (ctx, flags) => {
      if (!flags.id) {
        throw new InputValidationError("required option '--id <id>' not specified");
      }
      if (!flags["record-id"]) {
        throw new InputValidationError("required option '--record-id <record-id>' not specified");
      }

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
