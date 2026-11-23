import { DebugKey, ErrorReportKey } from "../handlers/keys";
import { type Middleware } from "../router";

export function withErrorReport(): Middleware {
  return (h) => ({
    name: () => h.name(),
    description: () => h.description(),
    flags: () => h.flags(),
    arguments: () => h.arguments(),
    doesSupportTui: () => h.doesSupportTui(),
    children: () => h.children(),
    handle: async (ctx, flags, args) => {
      const report = ctx.value(ErrorReportKey);
      if (report) report.debug = ctx.value(DebugKey) ?? false;
      await h.handle(ctx, flags, args);
    },
  });
}
