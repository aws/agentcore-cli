import type { FeatureFlag, FeatureFlags } from "../featureFlags";

/**
 * In-memory {@link FeatureFlags} for tests: enabled flags are whatever the test
 * lists, so a test can turn an experiment on without touching the environment.
 */
export class TestFeatureFlags implements FeatureFlags {
  private readonly enabledFlags: ReadonlySet<FeatureFlag>;

  constructor(enabled: FeatureFlag[] = []) {
    this.enabledFlags = new Set(enabled);
  }

  isEnabled(flag: FeatureFlag): boolean {
    return this.enabledFlags.has(flag);
  }

  enabled(): FeatureFlag[] {
    return [...this.enabledFlags];
  }
}
