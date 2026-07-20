import { Router } from "../../router";
import type { AppIO, Core } from "../types";
import { createRuntimeEndpointHandler } from "./endpoint";
import { createGetRuntimeHandler } from "./get";
import { createHelpDefault } from "./help";
import { createListRuntimesHandler } from "./list";
import { createRuntimeVersionHandler } from "./version";

export function createRuntimeHandler(core: Core, io: AppIO): Router {
  return new Router("runtime", "inspect AgentCore Runtimes")
    .hideFromTui()
    .default(createHelpDefault(io))
    .handler(createGetRuntimeHandler(core))
    .handler(createListRuntimesHandler(core))
    .handler(createRuntimeVersionHandler(core, io))
    .handler(createRuntimeEndpointHandler(core, io));
}
