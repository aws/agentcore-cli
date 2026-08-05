import type { AppIO } from "../../../io";
import { Router } from "../../../router";
import { createHelpDefault } from "../../help";
import type { Core } from "../../types";
import { createCreateGatewayConnectorHandler } from "./create";
import { createGetGatewayConnectorHandler } from "./get";
import { createListGatewayConnectorsHandler } from "./list";

export function createGatewayConnectorHandler(core: Core, io: AppIO): Router {
  return new Router("connector", "inspect connectors configured for an AgentCore Gateway")
    .default(createHelpDefault(io))
    .handler(createCreateGatewayConnectorHandler(core, io))
    .handler(createGetGatewayConnectorHandler(core))
    .handler(createListGatewayConnectorsHandler(core));
}
