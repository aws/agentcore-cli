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
  setupOAuth2Providers,
  hasIdentityApiProviders,
  hasIdentityOAuthProviders,
  getMissingCredentials,
  getAllCredentials,
  type SetupApiKeyProvidersOptions,
  type SetupOAuth2ProvidersOptions,
  type PreDeployIdentityResult,
  type PreDeployOAuth2Result,
  type ApiKeyProviderSetupResult,
  type OAuth2ProviderSetupResult,
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
} from './teardown';

// Post-deploy observability setup
export { setupTransactionSearch } from './post-deploy-observability';

// Post-deploy HTTP gateways
export {
  setupHttpGateways,
  type SetupHttpGatewaysOptions,
  type SetupHttpGatewaysResult,
  type HttpGatewaySetupResult,
} from './post-deploy-http-gateways';

// Post-deploy online eval enablement
export {
  enableOnlineEvalConfigs,
  type EnableOnlineEvalsOptions,
  type EnableOnlineEvalsResult,
  type OnlineEvalEnableResult,
} from './post-deploy-online-evals';

// Post-deploy config bundles
export {
  setupConfigBundles,
  type SetupConfigBundlesOptions,
  type SetupConfigBundlesResult,
  type ConfigBundleSetupResult,
} from './post-deploy-config-bundles';

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
