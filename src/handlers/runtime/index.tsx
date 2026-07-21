import { Router } from "../../router";
import { renderTui } from "../../tui";
import type { AppIO, Core } from "../types";
import { createRuntimeEndpointHandler } from "./endpoint";
import { createGetRuntimeHandler } from "./get";
import { RuntimeInteractiveKey, withRuntimeInteractive } from "./interactive";
import { createListRuntimesHandler } from "./list";
import { createRuntimeVersionHandler } from "./version";

export function createRuntimeHandler(core: Core, io: AppIO): Router {
  return new Router("runtime", "inspect AgentCore Runtimes")
    .groupFlags(RuntimeInteractiveKey)
    .use(withRuntimeInteractive(core, io))
    .default(renderTui(core, io))
    .handler(createGetRuntimeHandler(core))
    .handler(createListRuntimesHandler(core))
    .handler(createRuntimeVersionHandler(core, io))
    .handler(createRuntimeEndpointHandler(core, io));
}
