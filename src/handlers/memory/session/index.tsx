import { Router } from "../../../router";
import { renderTui } from "../../../tui";
import type { AppIO } from "../../../io";
import type { Core } from "../../types";
import { createListMemorySessionsHandler } from "./list";

export function createMemorySessionHandler(core: Core, io: AppIO): Router {
  return new Router("session", "inspect sessions in AgentCore Memories")
    .default(renderTui(core, io))
    .handler(createListMemorySessionsHandler(core));
}
