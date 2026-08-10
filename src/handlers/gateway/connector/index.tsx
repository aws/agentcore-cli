import type { AppIO } from "../../../io";
import { Router } from "../../../router";
import { createHelpDefault } from "../../help";
import type { Core } from "../../types";
import { createGetGatewayConnectorHandler } from "./get";
import { createListGatewayConnectorsHandler } from "./list";

export function createGatewayConnectorHandler(core: Core, io: AppIO): Router {
  return new Router("connector", "inspect connectors configured for an AgentCore Gateway")
    .default(createHelpDefault(io))
    .handler(createGetGatewayConnectorHandler(core))
    .handler(createListGatewayConnectorsHandler(core));
}
