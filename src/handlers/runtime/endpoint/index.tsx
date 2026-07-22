import { Router } from "../../../router";
import type { AppIO, Core } from "../../types";
import { createHelpDefault } from "../../help";
import { createGetRuntimeEndpointHandler } from "./get";
import { createListRuntimeEndpointsHandler } from "./list";

export function createRuntimeEndpointHandler(core: Core, io: AppIO): Router {
  return new Router("endpoint", "inspect AgentCore Runtime endpoints")
    .default(createHelpDefault(io))
    .handler(createGetRuntimeEndpointHandler(core))
    .handler(createListRuntimeEndpointsHandler(core));
}
