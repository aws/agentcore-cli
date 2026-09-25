import type { AppIO } from "../../../io";
import { Router } from "../../../router";
import { renderTui } from "../../../tui";
import type { Core } from "../../types";
import { createCreateGatewayRuleHandler } from "./create";
import { createDeleteGatewayRuleHandler } from "./delete";
import { createGetGatewayRuleHandler } from "./get";
import { createListGatewayRulesHandler } from "./list";
import { createUpdateGatewayRuleHandler } from "./update";

export function createGatewayRuleHandler(core: Core, io: AppIO): Router {
  return new Router("rule", "manage Rules for an AgentCore Gateway")
    .default(renderTui(core, io))
    .supportedTuiCommands("get", "list")
    .handler(createCreateGatewayRuleHandler(core, io))
    .handler(createUpdateGatewayRuleHandler(core, io))
    .handler(createGetGatewayRuleHandler(core))
    .handler(createListGatewayRulesHandler(core))
    .handler(createDeleteGatewayRuleHandler(core));
}
