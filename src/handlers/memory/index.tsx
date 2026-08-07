import { withTuiOnEmptyFlagsAndArgs } from "../../middleware";
import { Router } from "../../router";
import { renderTui } from "../../tui";
import type { AppIO } from "../../io";
import type { Core } from "../types";
import { createMemoryActorHandler } from "./actor";
import { createMemoryEventHandler } from "./event";
import { createGetMemoryHandler } from "./get";
import { createListMemoriesHandler } from "./list";
import { createMemoryRecordHandler } from "./record";
import { createMemorySessionHandler } from "./session";

export function createMemoryHandler(core: Core, io: AppIO): Router {
  return new Router("memory", "manage AgentCore Memories")
    .use(withTuiOnEmptyFlagsAndArgs(core, io))
    .default(renderTui(core, io))
    .handler(createGetMemoryHandler(core))
    .handler(createListMemoriesHandler(core))
    .handler(createMemoryEventHandler(core, io))
    .handler(createMemoryRecordHandler(core, io))
    .handler(createMemoryActorHandler(core, io))
    .handler(createMemorySessionHandler(core, io));
}
