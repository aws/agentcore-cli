import { FEATURE_FLAGS, type FeatureFlag, type FeatureFlags } from "./types";

/** The one value that switches a flag on. Anything else — including "true" — leaves it off. */
const ENABLED_VALUE = "1";

/**
 * Feature flags read from environment variables.
 *
 * Every flag maps to one variable (see {@link FEATURE_FLAGS}) and is enabled only
 * when that variable's trimmed value is exactly "1". The contract is deliberately
 * narrow — no truthiness rules — so an experiment cannot be turned on by accident
 * and the README can state it in one line.
 *
 * The environment is read once at construction, not on every call: a flag that
 * flipped mid-command could leave a deploy half in one mode and half in another.
 * `src/index.ts` passes `process.env`; nothing here reaches for it.
 */
export class EnvFeatureFlags implements FeatureFlags {
  private readonly enabledFlags: ReadonlySet<FeatureFlag>;

  constructor(processEnv: Record<string, string | undefined>) {
    const enabled = new Set<FeatureFlag>();
    for (const [flag, variable] of Object.entries(FEATURE_FLAGS) as [FeatureFlag, string][]) {
      if (processEnv[variable]?.trim() === ENABLED_VALUE) enabled.add(flag);
    }
    this.enabledFlags = enabled;
  }

  isEnabled(flag: FeatureFlag): boolean {
    return this.enabledFlags.has(flag);
  }

  enabled(): FeatureFlag[] {
    return [...this.enabledFlags];
  }
}
