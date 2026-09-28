import { renderTui } from "../../tui";
import type { AppIO } from "../../io";
import { withTuiOnEmptyFlagsAndArgs } from "../../middleware";
import { Router } from "../../router";
import type { Core } from "../types";
import { createGatewayConnectorHandler } from "./connector";
import { createGetGatewayHandler } from "./get";
import { createInvokeGatewayHandler } from "./invoke";
import { createListGatewaysHandler } from "./list";
import { createGatewayPolicyHandler } from "./policy";
import { createGatewayRuleHandler } from "./rule";
import { createGatewayTargetHandler } from "./target";

// Gateways, and their Targets, connectors, and Rules, are created and changed
// through AgentCore projects (`agentcore add gateway`, then `agentcore deploy`),
// so this group has no create or update commands and no Gateway delete.
export function createGatewayHandler(core: Core, io: AppIO): Router {
  return new Router("gateway", "manage AgentCore Gateways")
    .use(withTuiOnEmptyFlagsAndArgs(core, io))
    .default(renderTui(core, io))
    .supportedTuiCommands("get", "list", "invoke", "target", "connector", "rule", "policy")
    .handler(createGetGatewayHandler(core))
    .handler(createListGatewaysHandler(core))
    .handler(createInvokeGatewayHandler(core, io))
    .handler(createGatewayTargetHandler(core, io))
    .handler(createGatewayConnectorHandler(core, io))
    .handler(createGatewayRuleHandler(core, io))
    .handler(createGatewayPolicyHandler(core, io));
}
