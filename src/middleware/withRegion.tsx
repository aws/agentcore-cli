import { ProfileKey, RegionExplicitKey, RegionKey } from "../handlers/keys";
import { resolveRegion } from "../core/region";
import { type Middleware } from "../router";

// withRegion resolves the effective AWS region and pins it onto the context under
// RegionKey so the whole app uses a single, consistent value. There is always a
// region: it falls back to DEFAULT_REGION when nothing else is configured. It also
// records, under RegionExplicitKey, whether the raw --region flag was present
// before this resolution -- the only place that distinction is still observable.
export function withRegion(): Middleware {
  return (h) => ({
    name: () => h.name(),
    description: () => h.description(),
    flags: () => h.flags(),
    arguments: () => h.arguments(),
    doesSupportTui: () => h.doesSupportTui(),
    children: () => h.children(),
    handle: async (ctx, flags, args) => {
      const explicit = ctx.value(RegionKey) !== undefined;
      const region = await resolveRegion(ctx.value(RegionKey), ctx.value(ProfileKey));
      await h.handle(
        ctx.withValue(RegionKey, region).withValue(RegionExplicitKey, explicit),
        flags,
        args,
      );
    },
  });
}
