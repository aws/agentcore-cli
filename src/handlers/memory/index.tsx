import { Router } from "../../router";
import type { AppIO } from "../../io";
import type { Core } from "../types";
import { createHelpDefault } from "../help";
import { createGetMemoryHandler } from "./get";
import { createListMemoriesHandler } from "./list";

export function createMemoryHandler(core: Core, io: AppIO): Router {
  return new Router("memory", "manage AgentCore Memories")
    .default(createHelpDefault(io))
    .handler(createGetMemoryHandler(core))
    .handler(createListMemoriesHandler(core));
}
