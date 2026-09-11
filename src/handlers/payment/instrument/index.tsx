import type { AppIO } from "../../../io";
import { Router } from "../../../router";
import { renderTui } from "../../../tui";
import type { Core } from "../../types";
import { createGetPaymentInstrumentHandler } from "./get";
import { createListPaymentInstrumentsHandler } from "./list";
import { createGetPaymentInstrumentBalanceHandler } from "./balance";

export function createPaymentInstrumentHandler(core: Core, io: AppIO): Router {
  return new Router("instrument", "manage payment instruments (embedded crypto wallets)")
    .default(renderTui(core, io))
    .handler(createGetPaymentInstrumentHandler(core))
    .handler(createListPaymentInstrumentsHandler(core))
    .handler(createGetPaymentInstrumentBalanceHandler(core));
}
