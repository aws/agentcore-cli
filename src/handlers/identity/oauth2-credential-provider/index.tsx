import { Router } from "../../../router";
import { renderTui } from "../../../tui";
import type { AppIO } from "../../../io";
import type { Core } from "../../types";
import { createCreateOauth2CredentialProviderHandler } from "./create";
import { createDeleteOauth2CredentialProviderHandler } from "./delete";
import { createGetOauth2CredentialProviderHandler } from "./get";
import { createListOauth2CredentialProvidersHandler } from "./list";
import { createUpdateOauth2CredentialProviderHandler } from "./update";

export function createOauth2CredentialProviderHandler(core: Core, io: AppIO): Router {
  return new Router("oauth2-credential-provider", "manage OAuth2 credential providers")
    .default(renderTui(core, io))
    .handler(createCreateOauth2CredentialProviderHandler(core, io))
    .handler(createGetOauth2CredentialProviderHandler(core))
    .handler(createListOauth2CredentialProvidersHandler(core))
    .handler(createUpdateOauth2CredentialProviderHandler(core, io))
    .handler(createDeleteOauth2CredentialProviderHandler(core));
}
