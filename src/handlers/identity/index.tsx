import { Router } from "../../router";
import type { AppIO, Core } from "../types";
import { createApiKeyCredentialProviderHandler } from "./api-key-credential-provider";
import { createHelpDefault } from "../help";

export function createIdentityHandler(core: Core, io: AppIO): Router {
  return new Router("identity", "manage AgentCore Identity resources")
    .default(createHelpDefault(io))
    .handler(createApiKeyCredentialProviderHandler(core, io));
}
