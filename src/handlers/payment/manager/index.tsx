import type { AppIO } from "../../../io";
import { Router } from "../../../router";
import { renderTui } from "../../../tui";
import type { Core } from "../../types";
import { createCreatePaymentManagerHandler } from "./create";
import { createDeletePaymentManagerHandler } from "./delete";
import { createGetPaymentManagerHandler } from "./get";
import { createListPaymentManagersHandler } from "./list";
import { createUpdatePaymentManagerHandler } from "./update";

export function createPaymentManagerHandler(core: Core, io: AppIO): Router {
  return new Router("manager", "manage AgentCore payment managers")
    .default(renderTui(core, io))
    .handler(createCreatePaymentManagerHandler(core, io))
    .handler(createGetPaymentManagerHandler(core))
    .handler(createListPaymentManagersHandler(core))
    .handler(createUpdatePaymentManagerHandler(core, io))
    .handler(createDeletePaymentManagerHandler(core));
}
