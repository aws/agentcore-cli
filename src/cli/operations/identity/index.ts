export {
  apiKeyProviderExists,
  createApiKeyProvider,
  setTokenVaultKmsKey,
  updateApiKeyProvider,
} from './api-key-credential-provider';
export {
  createOAuth2Provider,
  getOAuth2Provider,
  oAuth2ProviderExists,
  updateOAuth2Provider,
  type OAuth2ProviderParams,
  type OAuth2ProviderResult,
} from './oauth2-credential-provider';
// Re-export credential utilities from primitives for backward compatibility
// (these were previously exported from the now-deleted create-identity.ts)
export { computeDefaultCredentialEnvVarName } from '../../primitives/credential-utils';
export { type CredentialStrategy } from '../../primitives/CredentialPrimitive';
