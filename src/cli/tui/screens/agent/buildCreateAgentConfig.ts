import type { GenerateConfig } from '../generate/types';
import type { AddAgentConfig } from './types';
import { DEFAULT_PYTHON_VERSION } from './types';

/**
 * Map a completed generate-wizard {@link GenerateConfig} to the {@link AddAgentConfig} consumed by
 * the `add agent` create path. Pure so it can be unit-tested independently of the React screen —
 * a regression here silently drops fields from the created agent (e.g. the capacity-provider
 * attachment, which had exactly that bug and no test coverage before).
 */
export function buildCreateAgentConfig(name: string, config: GenerateConfig): AddAgentConfig {
  return {
    name,
    agentType: 'create',
    codeLocation: `${name}/`,
    entrypoint: 'main.py',
    language: config.language,
    buildType: config.buildType,
    ...(config.buildType === 'Container' && config.dockerfile && { dockerfile: config.dockerfile }),
    protocol: config.protocol,
    framework: config.sdk,
    modelProvider: config.modelProvider,
    apiKey: config.apiKey,
    // A capacity provider supplies its own network topology, so a CP-attached runtime carries no
    // networkMode/networkConfig (they are mutually exclusive). Drop any network selection here.
    networkMode: config.capacityProviderConfiguration ? undefined : config.networkMode,
    subnets: !config.capacityProviderConfiguration && config.networkMode === 'VPC' ? config.subnets : undefined,
    securityGroups:
      !config.capacityProviderConfiguration && config.networkMode === 'VPC' ? config.securityGroups : undefined,
    ...(!config.capacityProviderConfiguration &&
      config.networkMode === 'VPC' &&
      config.buildType === 'Container' &&
      config.vpcId && { vpcId: config.vpcId }),
    requestHeaderAllowlist: config.requestHeaderAllowlist,
    ...(config.authorizerType && config.authorizerType !== 'AWS_IAM' && { authorizerType: config.authorizerType }),
    ...(config.authorizerType === 'CUSTOM_JWT' && config.jwtConfig && { jwtConfig: config.jwtConfig }),
    idleRuntimeSessionTimeout: config.idleRuntimeSessionTimeout,
    maxLifetime: config.maxLifetime,
    sessionStorageMountPath: config.sessionStorageMountPath,
    ...(config.efsAccessPoints?.length && { efsAccessPoints: config.efsAccessPoints }),
    ...(config.s3AccessPoints?.length && { s3AccessPoints: config.s3AccessPoints }),
    ...(config.capacityProviderConfiguration && {
      capacityProviderConfiguration: config.capacityProviderConfiguration,
    }),
    ...(config.capacityProviderVolumes?.length && { capacityProviderVolumes: config.capacityProviderVolumes }),
    withConfigBundle: config.withConfigBundle,
    pythonVersion: DEFAULT_PYTHON_VERSION,
    memory: config.memory,
  };
}
