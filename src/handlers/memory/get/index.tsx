import z from "zod";
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
      flag("id", "the ID of the Memory", z.string().min(1)),
      flag("view", "response view", z.enum(MEMORY_VIEWS).optional()),
    ],
    handle: async (ctx, flags) => {
      ctx
        .require(JsonRendererKey)
        .renderJson(
          await core.memory.getMemory(flags.id, flags.view ?? "full", coreOptsFromCtx(ctx)),
        );
    },
  });
