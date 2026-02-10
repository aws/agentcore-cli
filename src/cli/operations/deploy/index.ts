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
  getAllCredentials,
  type SetupApiKeyProvidersOptions,
  type PreDeployIdentityResult,
  type ApiKeyProviderSetupResult,
  type MissingCredential,
} from './pre-deploy-identity';

// Teardown utilities (moved from destroy operations)
export {
  discoverDeployedTargets,
  destroyTarget,
  getCdkProjectDir,
  performStackTeardown,
  type DeployedTarget,
  type DiscoverDeployedResult,
  type DestroyTargetOptions,
  type StackTeardownResult,
} from './teardown';

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
