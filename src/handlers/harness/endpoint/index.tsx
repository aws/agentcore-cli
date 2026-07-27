import { renderTui } from "../../../tui";
import { Router } from "../../../router";
import type { AppIO } from "../../../io";
import type { Core } from "../../types";
import { createCreateEndpointHandler } from "./create";
import { createGetEndpointHandler } from "./get";
import { createListEndpointsHandler } from "./list";
import { createUpdateEndpointHandler } from "./update";
import { createDeleteEndpointHandler } from "./delete";

export function createEndpointHandler(core: Core, io: AppIO): Router {
  const endpoint = new Router("endpoint", "manage harness endpoints");

  // Open the TUI at this root, i.e., `agentcore harness endpoint`. Leaves
  // inherit the harness router's TUI-on-empty-flags middleware.
  endpoint.default(renderTui(core, io));

  // Register handlers
  endpoint.handler(createCreateEndpointHandler(core));
  endpoint.handler(createGetEndpointHandler(core));
  endpoint.handler(createListEndpointsHandler(core));
  endpoint.handler(createUpdateEndpointHandler(core));
  endpoint.handler(createDeleteEndpointHandler(core));

  return endpoint;
}

export { HarnessEndpointScreen } from "./screen.tsx";
