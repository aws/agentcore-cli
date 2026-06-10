/**
 * Compute the default env var name for a credential.
 * Extracted to a standalone utility to avoid circular dependencies
 * between CredentialPrimitive and TUI screens that use this function.
 */
export function computeDefaultCredentialEnvVarName(credentialName: string): string {
  return `AGENTCORE_CREDENTIAL_${credentialName.replace(/-/g, '_').toUpperCase()}`;
}

/**
 * Compute the managed OAuth credential name for a gateway.
 * Used when creating the credential (GatewayPrimitive) and when
 * looking it up for code generation (schema-mapper).
 */
export function computeManagedOAuthCredentialName(gatewayName: string): string {
  return `${gatewayName}-oauth`;
}

/**
 * Compute the env var names for a CoinbaseCDP payment credential.
 * CoinbaseCDP credentials require 3 env vars.
 */
export function computePaymentCredentialEnvVarNames(credentialName: string): {
  apiKeyId: string;
  apiKeySecret: string;
  walletSecret: string;
} {
  const prefix = `AGENTCORE_CREDENTIAL_${credentialName.replace(/-/g, '_').toUpperCase()}`;
  return {
    apiKeyId: `${prefix}_API_KEY_ID`,
    apiKeySecret: `${prefix}_API_KEY_SECRET`,
    walletSecret: `${prefix}_WALLET_SECRET`,
  };
}

/**
 * Compute the env var names for a StripePrivy payment credential.
 * StripePrivy credentials require 4 env vars.
 */
export function computeStripePrivyCredentialEnvVarNames(credentialName: string): {
  appId: string;
  appSecret: string;
  authorizationPrivateKey: string;
  authorizationId: string;
} {
  const prefix = `AGENTCORE_CREDENTIAL_${credentialName.replace(/-/g, '_').toUpperCase()}`;
  return {
    appId: `${prefix}_APP_ID`,
    appSecret: `${prefix}_APP_SECRET`,
    authorizationPrivateKey: `${prefix}_AUTHORIZATION_PRIVATE_KEY`,
    authorizationId: `${prefix}_AUTHORIZATION_ID`,
  };
}
