import { Router } from "../../router";
import type { AppIO } from "../../io";
import type { Core } from "../types";
import { createApiKeyCredentialProviderHandler } from "./api-key-credential-provider";
import { createOauth2CredentialProviderHandler } from "./oauth2-credential-provider";
import { createHelpDefault } from "../help";

export function createIdentityHandler(core: Core, io: AppIO): Router {
  return new Router("identity", "manage AgentCore Identity resources")
    .default(createHelpDefault(io))
    .handler(createApiKeyCredentialProviderHandler(core, io))
    .handler(createOauth2CredentialProviderHandler(core, io));
}
