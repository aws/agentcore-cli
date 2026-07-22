import { Router } from "../../../router";
import type { AppIO, Core } from "../../types";
import { createHelpDefault } from "../../help";
import { createGetRuntimeVersionHandler } from "./get";
import { createListRuntimeVersionsHandler } from "./list";

export function createRuntimeVersionHandler(core: Core, io: AppIO): Router {
  return new Router("version", "inspect AgentCore Runtime versions")
    .default(createHelpDefault(io))
    .handler(createGetRuntimeVersionHandler(core))
    .handler(createListRuntimeVersionsHandler(core));
}
