import { renderTui } from "../../tui";
import type { GlobalConfig } from "../../globalConfig";
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
import { createGatewayPolicyHandler } from "./policy";
import { createGatewayRuleHandler } from "./rule";
import { createGatewayTargetHandler } from "./target";
import { createUpdateGatewayHandler } from "./update";

export function createGatewayHandler(core: Core, io: AppIO, globalConfig: GlobalConfig): Router {
  const imperativeMutationCommands = globalConfig["imperative-mutation-commands"];
  const router = new Router("gateway", "manage AgentCore Gateways")
    .use(withTuiOnEmptyFlagsAndArgs(core, io))
    .default(renderTui(core, io))
    .supportedTuiCommands("get", "list", "invoke", "target", "connector", "rule", "policy");
  if (imperativeMutationCommands) {
    router
      .handler(createCreateGatewayHandler(core, io))
      .handler(createUpdateGatewayHandler(core, io));
  }
  router.handler(createGetGatewayHandler(core)).handler(createListGatewaysHandler(core));
  if (imperativeMutationCommands) router.handler(createDeleteGatewayHandler(core));
  return router
    .handler(createInvokeGatewayHandler(core, io))
    .handler(createGatewayTargetHandler(core, io, imperativeMutationCommands))
    .handler(createGatewayConnectorHandler(core, io, imperativeMutationCommands))
    .handler(createGatewayRuleHandler(core, io, imperativeMutationCommands))
    .handler(createGatewayPolicyHandler(core, io));
}
