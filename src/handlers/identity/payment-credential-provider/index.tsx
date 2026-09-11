import { Router } from "../../../router";
import { renderTui } from "../../../tui";
import type { AppIO } from "../../../io";
import type { Core } from "../../types";
import { createGetPaymentCredentialProviderHandler } from "./get";
import { createListPaymentCredentialProvidersHandler } from "./list";

export function createPaymentCredentialProviderHandler(core: Core, io: AppIO): Router {
  return new Router("payment-credential-provider", "manage payment credential providers")
    .default(renderTui(core, io))
    .supportedTuiCommands()
    .handler(createGetPaymentCredentialProviderHandler(core))
    .handler(createListPaymentCredentialProvidersHandler(core));
}
