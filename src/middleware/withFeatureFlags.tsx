import { FeatureFlagsKey, type Middleware } from "../router";
import type { FeatureFlags } from "../featureFlags";

/**
 * Middleware that pins a {@link FeatureFlags} instance on the context, making it
 * available to every handler and screen beneath the mount point via
 * `ctx.require(FeatureFlagsKey).isEnabled(...)`.
 */
export function withFeatureFlags(flags: FeatureFlags): Middleware {
  return (h) => ({
    name: () => h.name(),
    description: () => h.description(),
    flags: () => h.flags(),
    arguments: () => h.arguments(),
    doesSupportTui: () => h.doesSupportTui(),
    children: () => h.children(),
    handle: async (ctx, handlerFlags, args) => {
      await h.handle(ctx.withValue(FeatureFlagsKey, flags), handlerFlags, args);
    },
  });
}
