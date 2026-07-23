import type { GlobalConfig, GlobalConfigFileData } from "./types";
/**
 * Default values for the global config. Includes a unique installationId for each process.
 */
export const getDefaultGlobalConfig = once<GlobalConfig>(() => ({
  telemetry: {
    enabled: true,
    audit: false,
    endpoint: "https://telemetry.agentcore.aws.dev",
  },
  installationId: crypto.randomUUID(),
}));

/**
 * Applies the given overrides from given {@link GlobalConfigFileData} to {@link getDefaultGlobalConfig} and returns the merged result
 */
export function resolveConfig(globalConfigFile: GlobalConfigFileData): GlobalConfig {
  const defaults = getDefaultGlobalConfig();
  return {
    telemetry: {
      enabled: globalConfigFile.telemetry?.enabled ?? defaults.telemetry.enabled,
      audit: globalConfigFile.telemetry?.audit ?? defaults.telemetry.audit,
      endpoint: globalConfigFile.telemetry?.endpoint ?? defaults.telemetry.endpoint,
    },
    installationId: globalConfigFile.installationId ?? defaults.installationId,
  };
}

/** Wraps a zero-arg factory so it executes at most once; subsequent calls return the cached result. */
function once<T>(fn: () => T): () => T {
  let value: T;
  let called = false;
  return () => {
    if (!called) {
      value = fn();
      called = true;
    }
    return value;
  };
}
