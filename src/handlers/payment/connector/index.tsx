import type { AppIO } from "../../../io";
import { Router } from "../../../router";
import { renderTui } from "../../../tui";
import type { Core } from "../../types";
import { createCreatePaymentConnectorHandler } from "./create";
import { createDeletePaymentConnectorHandler } from "./delete";
import { createGetPaymentConnectorHandler } from "./get";
import { createListPaymentConnectorsHandler } from "./list";
import { createUpdatePaymentConnectorHandler } from "./update";

export function createPaymentConnectorHandler(core: Core, io: AppIO): Router {
  return new Router("connector", "manage connectors under a payment manager")
    .default(renderTui(core, io))
    .handler(createCreatePaymentConnectorHandler(core, io))
    .handler(createGetPaymentConnectorHandler(core, io))
    .handler(createListPaymentConnectorsHandler(core))
    .handler(createUpdatePaymentConnectorHandler(core))
    .handler(createDeletePaymentConnectorHandler(core));
}
