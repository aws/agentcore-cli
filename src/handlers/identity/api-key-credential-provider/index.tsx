import { Router } from "../../../router";
import { renderTui } from "../../../tui";
import type { AppIO } from "../../../io";
import type { Core } from "../../types";
import { createCreateApiKeyCredentialProviderHandler } from "./create";
import { createDeleteApiKeyCredentialProviderHandler } from "./delete";
import { createGetApiKeyCredentialProviderHandler } from "./get";
import { createListApiKeyCredentialProvidersHandler } from "./list";
import { createUpdateApiKeyCredentialProviderHandler } from "./update";

export function createApiKeyCredentialProviderHandler(core: Core, io: AppIO): Router {
  return new Router("api-key-credential-provider", "manage API key credential providers")
    .default(renderTui(core, io))
    .handler(createCreateApiKeyCredentialProviderHandler(core, io))
    .handler(createGetApiKeyCredentialProviderHandler(core))
    .handler(createListApiKeyCredentialProvidersHandler(core))
    .handler(createUpdateApiKeyCredentialProviderHandler(core, io))
    .handler(createDeleteApiKeyCredentialProviderHandler(core));
}
