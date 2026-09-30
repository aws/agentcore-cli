import { Router } from "../../../../router";
import { renderTui } from "../../../../tui";
import type { Core } from "../../../types";
import type { AddProjectResourceConfig } from "../types";
import { createAddApiKeyCredentialHandler } from "./api-key";
import { createAddOauthCredentialHandler } from "./oauth";
import { createAddPaymentCredentialHandler } from "./payment";

export function createAddCredentialsHandler(config: AddProjectResourceConfig, core: Core): Router {
  const credentials = new Router(
    "credentials",
    "add AgentCore Identity credential providers to the current project",
  )
    .default(renderTui(core, config.io))
    .supportedTuiCommands("api-key");
  credentials.handler(createAddApiKeyCredentialHandler(config));
  credentials.handler(createAddOauthCredentialHandler(config));
  credentials.handler(createAddPaymentCredentialHandler(config));
  return credentials;
}
