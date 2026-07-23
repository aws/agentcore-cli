import { GlobalConfigAccessorKey, type Middleware } from "../router";
import type { GlobalConfigAccessor } from "../globalConfig";

/**
 * Middleware that pins a GlobalConfigAccessor on the context, making it
 * available to every handler beneath the mount point via
 * `ctx.require(GlobalConfigAccessorKey)`.
 */
export function withGlobalConfigAccessor(accessor: GlobalConfigAccessor): Middleware {
  return (h) => ({
    name: () => h.name(),
    description: () => h.description(),
    flags: () => h.flags(),
    arguments: () => h.arguments(),
    children: () => h.children(),
    handle: async (ctx, flags, args) => {
      await h.handle(ctx.withValue(GlobalConfigAccessorKey, accessor), flags, args);
    },
  });
}
