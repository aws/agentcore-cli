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
