import { renderTui } from "../../tui";
import type { AppIO } from "../../io";
import { withTuiOnEmptyFlagsAndArgs } from "../../middleware";
import { Router } from "../../router";
import type { Core } from "../types";
import { createGatewayConnectorHandler } from "./connector";
import { createCreateGatewayHandler } from "./create";
import { createDeleteGatewayHandler } from "./delete";
import { createGetGatewayHandler } from "./get";
import { createInvokeGatewayHandler } from "./invoke";
import { createListGatewaysHandler } from "./list";
import { createGatewayRuleHandler } from "./rule";
import { createGatewayTargetHandler } from "./target";
import { createUpdateGatewayHandler } from "./update";

export function createGatewayHandler(core: Core, io: AppIO): Router {
  return new Router("gateway", "inspect AgentCore Gateways")
    .use(withTuiOnEmptyFlagsAndArgs(core, io))
    .default(renderTui(core, io))
    .supportedTuiCommands("get", "list", "invoke", "target", "connector", "rule")
    .handler(createCreateGatewayHandler(core, io))
    .handler(createUpdateGatewayHandler(core, io))
    .handler(createGetGatewayHandler(core))
    .handler(createListGatewaysHandler(core))
    .handler(createDeleteGatewayHandler(core))
    .handler(createInvokeGatewayHandler(core, io))
    .handler(createGatewayTargetHandler(core, io))
    .handler(createGatewayConnectorHandler(core, io))
    .handler(createGatewayRuleHandler(core, io));
}
