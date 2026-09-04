import { renderTui } from "../../tui";
import { withTuiOnEmptyFlagsAndArgs } from "../../middleware";
import { Router } from "../../router";
import type { AppIO } from "../../io";
import type { Core } from "../types";
import { createGetHarnessHandler } from "./get";
import { createListHarnessHandler } from "./list";
import { createCreateHarnessHandler } from "./create";
import { createUpdateHarnessHandler } from "./update";
import { createDeleteHarnessHandler } from "./delete";
import { createInvokeHarnessHandler } from "./invoke";
import { createExecHarnessHandler } from "./exec";
import { createEndpointHandler } from "./endpoint";
import { createVersionHandler } from "./version";
import { createHarnessLogsHandler } from "./logs";
import { createHarnessTracesHandler } from "./traces";

export function createHarnessHandler(core: Core, io: AppIO): Router {
  const harness = new Router("harness", "manage AgentCore harnesses");

  // Open the TUI by default if no flags or arguments are passed
  harness.use(withTuiOnEmptyFlagsAndArgs(core, io));
  // Open the TUI at this root, i.e., `agentcore harness`
  harness.default(renderTui(core, io));

  // Register handlers
  harness.handler(createCreateHarnessHandler(core));
  harness.handler(createGetHarnessHandler(core));
  harness.handler(createListHarnessHandler(core));
  harness.handler(createUpdateHarnessHandler(core));
  harness.handler(createDeleteHarnessHandler(core));
  harness.handler(createInvokeHarnessHandler(core, io));
  harness.handler(createExecHarnessHandler(core, io));
  harness.handler(createHarnessLogsHandler(core, io));
  harness.handler(createHarnessTracesHandler(core, io));

  // Endpoint and version commands live under their own sub-routers, e.g.
  // `agentcore harness endpoint create`.
  harness.handler(createEndpointHandler(core, io));
  harness.handler(createVersionHandler(core, io));

  return harness;
}

export { HarnessScreen } from "./screen.tsx";
