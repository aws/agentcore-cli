/**
 * Compute the default env var name for a credential.
 * Extracted to a standalone utility to avoid circular dependencies
 * between CredentialPrimitive and TUI screens that use this function.
 */
export function computeDefaultCredentialEnvVarName(credentialName: string): string {
  return `AGENTCORE_CREDENTIAL_${credentialName.replace(/-/g, '_').toUpperCase()}`;
}
