import type { AppIO } from "../../../io";
import { Router } from "../../../router";
import { renderTui } from "../../../tui";
import type { Core } from "../../types";
import { createGetPaymentSessionHandler } from "./get";
import { createListPaymentSessionsHandler } from "./list";

export function createPaymentSessionHandler(core: Core, io: AppIO): Router {
  return new Router("session", "manage payment sessions (budget-limited payment contexts)")
    .default(renderTui(core, io))
    .handler(createGetPaymentSessionHandler(core))
    .handler(createListPaymentSessionsHandler(core));
}
