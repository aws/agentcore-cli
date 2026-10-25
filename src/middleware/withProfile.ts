import { AwsCredentialProviderKey, ProfileKey, RegionKey } from "../handlers/keys";
import { selectedAwsProfile, withAwsProfile } from "../awsProfile";
import type { Middleware } from "../router";

export function withProfile(): Middleware {
  return (handler) => ({
    name: () => handler.name(),
    description: () => handler.description(),
    flags: () => handler.flags(),
    arguments: () => handler.arguments(),
    doesSupportTui: () => handler.doesSupportTui(),
    children: () => handler.children(),
    handle: async (ctx, flags, args) => {
      const profile = ctx.value(ProfileKey);
      if (profile === undefined) return handler.handle(ctx, flags, args);
      await withAwsProfile(
        profile,
        () =>
          handler.handle(
            ctx.withValue(AwsCredentialProviderKey, selectedAwsProfile()!.credentials),
            flags,
            args,
          ),
        ctx.value(RegionKey),
      );
    },
  });
}
