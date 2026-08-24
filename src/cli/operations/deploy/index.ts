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
  assertEnvFileExists,
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

// Pre-deploy payment credential setup
export {
  setupPaymentCredentialProviders,
  hasPaymentCredentialProviders,
  cleanupPaymentCredentialProviders,
  type SetupPaymentCredentialProvidersOptions,
  type PaymentCredentialProvidersResult,
  type PaymentCredentialProviderResult,
} from './pre-deploy-identity';

// Post-deploy observability setup
export { setupTransactionSearch } from './post-deploy-observability';

// Post-deploy online eval enablement
export {
  enableOnlineEvalConfigs,
  type EnableOnlineEvalsOptions,
  type EnableOnlineEvalsResult,
  type OnlineEvalEnableResult,
} from './post-deploy-online-evals';

export { ensureDefaultDeploymentTarget } from './ensure-target';

export {
  formatQuickCreateConnectorAuthorization,
  getQuickCreateConnectorAuthorizations,
  type QuickCreateConnectorAuthorization,
} from './payment-connector-authorization';

// Pre-synth backfill of vpcId for pre-existing Container+VPC configs written before vpcId was added
export { backfillContainerVpcIds, type BackfillVpcIdResult } from './backfill-vpc-id';

// Managed dependency pinning — shared by CLI deploy + TUI preflight
export {
  ensureManagedDependencies,
  failedSyncResult,
  teardownSyncFailureResult,
  toDepSyncAttrs,
  SYNC_CDK_DEPENDENCIES_STEP,
  type EnsureManagedDependenciesOptions,
} from './dependency-sync';

// Managed-memory heads-up (shared by the CLI command + TUI deploy flow + add harness)
export {
  MANAGED_MEMORY_DEPLOY_NOTICE,
  MANAGED_MEMORY_ADD_NOTICE,
  hasManagedMemoryHarness,
} from './managed-memory-notice';

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
