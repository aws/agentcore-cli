import { Router } from "../../../router";
import { renderTui } from "../../../tui";
import type { AppIO } from "../../../io";
import type { Core } from "../../types";
import { createCreatePaymentCredentialProviderHandler } from "./create";
import { createDeletePaymentCredentialProviderHandler } from "./delete";
import { createGetPaymentCredentialProviderHandler } from "./get";
import { createListPaymentCredentialProvidersHandler } from "./list";
import { createUpdatePaymentCredentialProviderHandler } from "./update";

export function createPaymentCredentialProviderHandler(core: Core, io: AppIO): Router {
  return new Router("payment-credential-provider", "manage payment credential providers")
    .default(renderTui(core, io))
    .supportedTuiCommands()
    .handler(createCreatePaymentCredentialProviderHandler(core, io))
    .handler(createGetPaymentCredentialProviderHandler(core))
    .handler(createListPaymentCredentialProvidersHandler(core))
    .handler(createUpdatePaymentCredentialProviderHandler(core, io))
    .handler(createDeletePaymentCredentialProviderHandler(core));
}
