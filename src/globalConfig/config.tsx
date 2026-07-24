import type { GlobalConfig, GlobalConfigFileData } from "./types";

/**
 * Default values for the global config. Includes a unique installationId for each process.
 */
export const DEFAULT_GLOBAL_CONFIG: GlobalConfig = {
  telemetry: {
    enabled: true,
    audit: false,
    endpoint: "https://telemetry.agentcore.aws.dev",
  },
  installationId: crypto.randomUUID(),
};

/**
 * Applies the given overrides from given {@link GlobalConfigFileData} to {@link DEFAULT_GLOBAL_CONFIG} and returns the merged result
 */
export function resolveConfig(globalConfigFile: GlobalConfigFileData): GlobalConfig {
  return {
    telemetry: {
      enabled: globalConfigFile.telemetry?.enabled ?? DEFAULT_GLOBAL_CONFIG.telemetry.enabled,
      audit: globalConfigFile.telemetry?.audit ?? DEFAULT_GLOBAL_CONFIG.telemetry.audit,
      endpoint: globalConfigFile.telemetry?.endpoint ?? DEFAULT_GLOBAL_CONFIG.telemetry.endpoint,
    },
    installationId: globalConfigFile.installationId ?? DEFAULT_GLOBAL_CONFIG.installationId,
  };
}
