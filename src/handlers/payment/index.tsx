import { withTuiOnEmptyFlagsAndArgs } from "../../middleware";
import { Router } from "../../router";
import { renderTui } from "../../tui";
import type { AppIO } from "../../io";
import type { Core } from "../types";
import { createPaymentConnectorHandler } from "./connector";
import { createPaymentInstrumentHandler } from "./instrument";
import { createPaymentManagerHandler } from "./manager";
import { createPaymentSessionHandler } from "./session";

export function createPaymentHandler(core: Core, io: AppIO): Router {
  return (
    new Router("payment", "manage AgentCore Payments")
      .use(withTuiOnEmptyFlagsAndArgs(core, io))
      .default(renderTui(core, io))
      // No payment screens ship yet: every leaf runs from the command line and the
      // menus list them as such. Widen this as screens land.
      .supportedTuiCommands()
      .handler(createPaymentManagerHandler(core, io))
      .handler(createPaymentConnectorHandler(core, io))
      .handler(createPaymentSessionHandler(core, io))
      .handler(createPaymentInstrumentHandler(core, io))
  );
}
