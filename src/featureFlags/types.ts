/** Every experimental switch the CLI knows, keyed by a stable code name. */
export const FEATURE_FLAGS = {
  imperativeDeploy: "AGENTCORE_CLI_EXPERIMENTAL_IMPERATIVE_DEPLOY",
} as const;

export type FeatureFlag = keyof typeof FEATURE_FLAGS;

/**
 * Answers whether an experimental feature is switched on for this process.
 *
 * Declared here (rather than in a handler's types file) because a feature flag
 * is cross-cutting: handlers, screens, and middleware all read it, and none of
 * them owns it. Implementations live beside it.
 */
export interface FeatureFlags {
  /** True when the flag's switch is on for this process. Never throws. */
  isEnabled(flag: FeatureFlag): boolean;
  /** The flags currently enabled, for logging/diagnostics. */
  enabled(): FeatureFlag[];
}
