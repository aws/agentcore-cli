import { Router } from "../../../router";
import type { AppIO } from "../../../io";
import type { Core } from "../../types";
import { createHelpDefault } from "../../help";
import { createCreateApiKeyCredentialProviderHandler } from "./create";
import { createDeleteApiKeyCredentialProviderHandler } from "./delete";
import { createGetApiKeyCredentialProviderHandler } from "./get";
import { createListApiKeyCredentialProvidersHandler } from "./list";
import { createUpdateApiKeyCredentialProviderHandler } from "./update";

export function createApiKeyCredentialProviderHandler(core: Core, io: AppIO): Router {
  return new Router("api-key-credential-provider", "manage API key credential providers")
    .default(createHelpDefault(io))
    .handler(createCreateApiKeyCredentialProviderHandler(core))
    .handler(createGetApiKeyCredentialProviderHandler(core))
    .handler(createListApiKeyCredentialProvidersHandler(core))
    .handler(createUpdateApiKeyCredentialProviderHandler(core))
    .handler(createDeleteApiKeyCredentialProviderHandler(core));
}
