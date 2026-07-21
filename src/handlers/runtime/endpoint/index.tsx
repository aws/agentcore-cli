import { Router } from "../../../router";
import { renderTui } from "../../../tui";
import type { AppIO, Core } from "../../types";
import { createGetRuntimeEndpointHandler } from "./get";
import { createListRuntimeEndpointsHandler } from "./list";

export function createRuntimeEndpointHandler(core: Core, io: AppIO): Router {
  return new Router("endpoint", "inspect AgentCore Runtime endpoints")
    .default(renderTui(core, io))
    .handler(createGetRuntimeEndpointHandler(core))
    .handler(createListRuntimeEndpointsHandler(core));
}
