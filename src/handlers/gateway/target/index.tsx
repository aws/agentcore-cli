import type { AppIO } from "../../../io";
import { Router } from "../../../router";
import { renderTui } from "../../../tui";
import type { Core } from "../../types";
import { createDeleteGatewayTargetHandler } from "./delete";
import { createGetGatewayTargetHandler } from "./get";
import { createListGatewayTargetsHandler } from "./list";

export function createGatewayTargetHandler(core: Core, io: AppIO): Router {
  return new Router("target", "manage Targets for an AgentCore Gateway")
    .default(renderTui(core, io))
    .supportedTuiCommands("get", "list")
    .handler(createGetGatewayTargetHandler(core))
    .handler(createListGatewayTargetsHandler(core))
    .handler(createDeleteGatewayTargetHandler(core));
}
