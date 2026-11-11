import { expect, test } from "bun:test";
import { isSensitiveKey } from "./sensitiveKeys";

test.each([
  "SERVICE_API_KEY",
  "PAYMENT_API_KEY_SECRET",
  "PAYMENT_WALLET_SECRET",
  "PAYMENT_AUTHORIZATION_PRIVATE_KEY",
  "PAYMENT_APP_SECRET",
  "OAUTH_CLIENT_SECRET",
  "AGENTCORE_CREDENTIAL_MODEL",
])("encrypts secret-bearing variable %s", (name) => {
  expect(isSensitiveKey(name)).toBe(true);
});

test.each([
  "AGENTCORE_CREDENTIAL_PAYMENT_API_KEY_ID",
  "AGENTCORE_CREDENTIAL_PAYMENT_APP_ID",
  "AGENTCORE_CREDENTIAL_PAYMENT_AUTHORIZATION_ID",
  "AGENTCORE_CREDENTIAL_OAUTH_CLIENT_ID",
  "AGENTCORE_CREDENTIAL_MODEL_NAME",
  "PORT",
  "STAGE",
])("leaves identifier/configuration variable %s readable", (name) => {
  expect(isSensitiveKey(name)).toBe(false);
});
