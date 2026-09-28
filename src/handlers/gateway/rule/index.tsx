import type { AppIO } from "../../../io";
import { Router } from "../../../router";
import { renderTui } from "../../../tui";
import type { Core } from "../../types";
import { createGetGatewayRuleHandler } from "./get";
import { createListGatewayRulesHandler } from "./list";

export function createGatewayRuleHandler(core: Core, io: AppIO): Router {
  return new Router("rule", "manage Rules for an AgentCore Gateway")
    .default(renderTui(core, io))
    .supportedTuiCommands("get", "list")
    .handler(createGetGatewayRuleHandler(core))
    .handler(createListGatewayRulesHandler(core));
}
