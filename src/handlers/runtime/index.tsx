import { withTuiOnEmptyFlagsAndArgs } from "../../middleware";
import { Router } from "../../router";
import { renderTui } from "../../tui";
import type { AppIO } from "../../io";
import type { Core } from "../types";
import { createRuntimeEndpointHandler } from "./endpoint";
import { createRuntimeExecHandler } from "./exec";
import { createGetRuntimeHandler } from "./get";
import { createInvokeRuntimeHandler } from "./invoke";
import { createListRuntimesHandler } from "./list";
import { createRuntimeLogsHandler } from "./logs";
import { createRuntimeShellHandler } from "./shell";
import { createRuntimeTracesHandler } from "./traces";
import { createRuntimeVersionHandler } from "./version";

export function createRuntimeHandler(core: Core, io: AppIO): Router {
  return new Router("runtime", "inspect hosted agent code, its endpoints, and versions")
    .use(withTuiOnEmptyFlagsAndArgs(core, io))
    .default(renderTui(core, io))
    .supportedTuiCommands("get", "list", "invoke", "shell", "exec", "version", "endpoint")
    .handler(createGetRuntimeHandler(core))
    .handler(createListRuntimesHandler(core))
    .handler(createInvokeRuntimeHandler(core, io))
    .handler(createRuntimeShellHandler(core, io))
    .handler(createRuntimeExecHandler(core, io))
    .commandSection("resources")
    .listInMenu("logs", "traces")
    .handler(createRuntimeVersionHandler(core, io))
    .handler(createRuntimeEndpointHandler(core, io))
    .handler(createRuntimeLogsHandler(core, io))
    .handler(createRuntimeTracesHandler(core, io));
}
