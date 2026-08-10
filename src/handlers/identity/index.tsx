import { withTuiOnEmptyFlagsAndArgs } from "../../middleware";
import { Router } from "../../router";
import { renderTui } from "../../tui";
import type { AppIO } from "../../io";
import type { Core } from "../types";
import { createApiKeyCredentialProviderHandler } from "./api-key-credential-provider";
import { createOauth2CredentialProviderHandler } from "./oauth2-credential-provider";

export function createIdentityHandler(core: Core, io: AppIO): Router {
  return new Router("identity", "manage AgentCore Identity resources")
    .use(withTuiOnEmptyFlagsAndArgs(core, io))
    .default(renderTui(core, io))
    .handler(createApiKeyCredentialProviderHandler(core, io))
    .handler(createOauth2CredentialProviderHandler(core, io));
}
