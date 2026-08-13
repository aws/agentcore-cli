import { Router } from "../../../router";
import { renderTui } from "../../../tui";
import type { AppIO } from "../../../io";
import type { Core } from "../../types";
import { createListMemoryActorsHandler } from "./list";

export function createMemoryActorHandler(core: Core, io: AppIO): Router {
  return new Router("actor", "inspect actors in AgentCore Memories")
    .default(renderTui(core, io))
    .handler(createListMemoryActorsHandler(core));
}
