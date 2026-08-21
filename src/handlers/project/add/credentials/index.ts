import { Router } from "../../../../router";
import type { AddProjectResourceConfig } from "../types";
import { createAddApiKeyCredentialHandler } from "./api-key";
import { createAddOauthCredentialHandler } from "./oauth";

export function createAddCredentialsHandler(config: AddProjectResourceConfig): Router {
  const credentials = new Router(
    "credentials",
    "add AgentCore Identity credential providers to the current project",
  );
  credentials.handler(createAddApiKeyCredentialHandler(config));
  credentials.handler(createAddOauthCredentialHandler(config));
  return credentials;
}
