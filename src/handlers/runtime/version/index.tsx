import { Router } from "../../../router";
import { renderTui } from "../../../tui";
import type { AppIO } from "../../../io";
import type { Core } from "../../types";
import { createGetRuntimeVersionHandler } from "./get";
import { createListRuntimeVersionsHandler } from "./list";

export function createRuntimeVersionHandler(core: Core, io: AppIO): Router {
  return new Router("version", "inspect AgentCore Runtime versions")
    .default(renderTui(core, io))
    .handler(createGetRuntimeVersionHandler(core))
    .handler(createListRuntimeVersionsHandler(core));
}
