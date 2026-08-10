import type { AppIO } from "../../../io";
import { Router } from "../../../router";
import { renderTui } from "../../../tui";
import type { Core } from "../../types";
import { createCreateGatewayRuleHandler } from "./create";
import { createGetGatewayRuleHandler } from "./get";
import { createListGatewayRulesHandler } from "./list";

export function createGatewayRuleHandler(core: Core, io: AppIO): Router {
  return new Router("rule", "inspect rules for an AgentCore Gateway")
    .default(renderTui(core, io))
    .handler(createCreateGatewayRuleHandler(core, io))
    .handler(createGetGatewayRuleHandler(core))
    .handler(createListGatewayRulesHandler(core));
}
