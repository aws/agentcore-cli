import { Router } from "../../../router";
import { renderTui } from "../../../tui";
import type { AppIO } from "../../../io";
import type { Core } from "../../types";
import { createGetMemoryEventHandler } from "./get";
import { createListMemoryEventsHandler } from "./list";

export function createMemoryEventHandler(core: Core, io: AppIO): Router {
  return new Router("event", "inspect AgentCore Memory events")
    .default(renderTui(core, io))
    .handler(createGetMemoryEventHandler(core))
    .handler(createListMemoryEventsHandler(core));
}
