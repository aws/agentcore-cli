import type { AppIO } from "../../../io";
import { Router } from "../../../router";
import { renderTui } from "../../../tui";
import type { Core } from "../../types";
import { createGetPaymentConnectorHandler } from "./get";
import { createListPaymentConnectorsHandler } from "./list";

export function createPaymentConnectorHandler(core: Core, io: AppIO): Router {
  return new Router("connector", "manage connectors under a payment manager")
    .default(renderTui(core, io))
    .handler(createGetPaymentConnectorHandler(core, io))
    .handler(createListPaymentConnectorsHandler(core));
}
