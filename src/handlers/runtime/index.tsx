import { withTuiOnEmptyFlagsAndArgs } from "../../middleware";
import { Router } from "../../router";
import { renderTui } from "../../tui";
import type { AppIO } from "../../io";
import type { Core } from "../types";
import { createRuntimeEndpointHandler } from "./endpoint";
import { createGetRuntimeHandler } from "./get";
import { createInvokeRuntimeHandler } from "./invoke";
import { createListRuntimesHandler } from "./list";
import { createRuntimeLogsHandler } from "./logs";
import { createRuntimeTracesHandler } from "./traces";
import { createRuntimeVersionHandler } from "./version";

export function createRuntimeHandler(core: Core, io: AppIO): Router {
  return (
    new Router("runtime", "inspect AgentCore Runtimes")
      .use(withTuiOnEmptyFlagsAndArgs(core, io))
      .default(renderTui(core, io))
      // logs and traces are headless-only: a bare `runtime logs` means "follow
      // the project runtime's logs", so neither may fall into the TUI.
      .supportedTuiCommands("get", "list", "invoke", "version", "endpoint")
      .handler(createGetRuntimeHandler(core))
      .handler(createListRuntimesHandler(core))
      .handler(createInvokeRuntimeHandler(core, io))
      .handler(createRuntimeVersionHandler(core, io))
      .handler(createRuntimeEndpointHandler(core, io))
      .handler(createRuntimeLogsHandler(core, io))
      .handler(createRuntimeTracesHandler(core, io))
  );
}
