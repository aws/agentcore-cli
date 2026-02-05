export {
  validateProject,
  buildCdkProject,
  synthesizeCdk,
  checkStackDeployability,
  checkBootstrapNeeded,
  bootstrapEnvironment,
  formatError,
  type PreflightContext,
  type SynthResult,
  type SynthOptions,
  type StackStatusCheckResult,
  type BootstrapCheckResult,
} from './preflight';

// Pre-deploy identity setup for non-Bedrock model providers
export {
  setupApiKeyProviders,
  hasOwnedIdentityApiProviders,
  getMissingCredentials,
  type SetupApiKeyProvidersOptions,
  type PreDeployIdentityResult,
  type ApiKeyProviderSetupResult,
  type MissingCredential,
} from './pre-deploy-identity';

// Re-export external requirements for convenience
export {
  checkDependencyVersions,
  checkNodeVersion,
  checkUvVersion,
  formatVersionError,
  requiresUv,
  parseSemVer,
  compareSemVer,
  semVerGte,
  formatSemVer,
  NODE_MIN_VERSION,
  type DependencyCheckResult,
  type SemVer,
  type VersionCheckResult,
} from '../../external-requirements';
