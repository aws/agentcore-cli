import type { AppIO } from "../../../io";
import { Router } from "../../../router";
import { createHelpDefault } from "../../help";
import type { Core } from "../../types";
import { createCreateGatewayTargetHandler } from "./create";
import { createGetGatewayTargetHandler } from "./get";
import { createListGatewayTargetsHandler } from "./list";

export function createGatewayTargetHandler(core: Core, io: AppIO): Router {
  return new Router("target", "inspect targets for an AgentCore Gateway")
    .default(createHelpDefault(io))
    .handler(createCreateGatewayTargetHandler(core, io))
    .handler(createGetGatewayTargetHandler(core))
    .handler(createListGatewayTargetsHandler(core));
}
