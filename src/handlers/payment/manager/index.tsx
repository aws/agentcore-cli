import type { AppIO } from "../../../io";
import { Router } from "../../../router";
import { renderTui } from "../../../tui";
import type { Core } from "../../types";
import { createGetPaymentManagerHandler } from "./get";
import { createListPaymentManagersHandler } from "./list";

export function createPaymentManagerHandler(core: Core, io: AppIO): Router {
  return new Router("manager", "manage AgentCore payment managers")
    .default(renderTui(core, io))
    .handler(createGetPaymentManagerHandler(core))
    .handler(createListPaymentManagersHandler(core));
}
