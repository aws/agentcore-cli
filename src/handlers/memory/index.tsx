import { withTuiOnEmptyFlagsAndArgs } from "../../middleware";
import { Router } from "../../router";
import { renderTui } from "../../tui";
import type { AppIO } from "../../io";
import type { Core } from "../types";
import { createGetMemoryHandler } from "./get";
import { createListMemoriesHandler } from "./list";

export function createMemoryHandler(core: Core, io: AppIO): Router {
  return new Router("memory", "manage AgentCore Memories")
    .use(withTuiOnEmptyFlagsAndArgs(core, io))
    .default(renderTui(core, io))
    .handler(createGetMemoryHandler(core))
    .handler(createListMemoriesHandler(core));
}
