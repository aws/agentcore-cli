import type { AppIO } from "../../io";
import { Router } from "../../router";
import { createHelpDefault } from "../help";
import type { Core } from "../types";
import { createGatewayConnectorHandler } from "./connector";
import { createGetGatewayHandler } from "./get";
import { createListGatewaysHandler } from "./list";
import { createGatewayRuleHandler } from "./rule";
import { createGatewayTargetHandler } from "./target";

export function createGatewayHandler(core: Core, io: AppIO): Router {
  return new Router("gateway", "inspect AgentCore Gateways")
    .default(createHelpDefault(io))
    .handler(createGetGatewayHandler(core))
    .handler(createListGatewaysHandler(core))
    .handler(createGatewayTargetHandler(core, io))
    .handler(createGatewayConnectorHandler(core, io))
    .handler(createGatewayRuleHandler(core, io));
}
