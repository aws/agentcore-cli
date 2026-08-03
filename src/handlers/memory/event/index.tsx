import { Router } from "../../../router";
import type { Core } from "../../types";
import { createGetMemoryEventHandler } from "./get";
import { createListMemoryEventsHandler } from "./list";

export function createMemoryEventHandler(core: Core): Router {
  return new Router("event", "inspect AgentCore Memory events")
    .handler(createGetMemoryEventHandler(core))
    .handler(createListMemoryEventsHandler(core));
}
