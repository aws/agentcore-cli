import z from "zod";
import { InputValidationError } from "../../../errors";
import { createHandler, flag } from "../../../router";
import { JsonRendererKey } from "../../../tui";
import type { Core } from "../../types";
import { coreOptsFromCtx } from "../../utils";

const MEMORY_VIEWS = ["full", "without_decryption"] as const;

export const createGetMemoryHandler = (core: Core) =>
  createHandler({
    name: "get",
    description: "get an AgentCore Memory",
    flags: [
      flag("id", "the ID of the Memory", z.string().optional()),
      flag("view", "response view", z.enum(MEMORY_VIEWS).optional()),
    ],
    handle: async (ctx, flags) => {
      if (!flags.id) {
        throw new InputValidationError("required option '--id <id>' not specified");
      }

      ctx
        .require(JsonRendererKey)
        .renderJson(
          await core.memory.getMemory(flags.id, flags.view ?? "full", coreOptsFromCtx(ctx)),
        );
    },
  });
