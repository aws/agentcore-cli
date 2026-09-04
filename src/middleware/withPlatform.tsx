import { PlatformKey, type Middleware } from "../router";

/**
 * Middleware that pins the host platform on the context so handlers make
 * Windows-specific decisions from `ctx.require(PlatformKey)` rather than
 * `process.platform`, which lets tests drive those branches on any host.
 */
export function withPlatform(platform: NodeJS.Platform): Middleware {
  return (h) => ({
    name: () => h.name(),
    description: () => h.description(),
    flags: () => h.flags(),
    arguments: () => h.arguments(),
    doesSupportTui: () => h.doesSupportTui(),
    children: () => h.children(),
    handle: async (ctx, flags, args) => {
      await h.handle(ctx.withValue(PlatformKey, platform), flags, args);
    },
  });
}
