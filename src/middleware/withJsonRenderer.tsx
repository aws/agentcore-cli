import { type Middleware } from "../router";
import { JsonRendererKey, renderJson } from "../tui";
import type { AppIO } from "../io";

// withJsonRenderer pins a JsonRenderer on the context, prewired to write to the
// injected stdout. Handlers emit machine-readable output via
// `ctx.require(JsonRendererKey).renderJson(data)` without knowing or caring where
// it goes, which keeps them decoupled from the process streams and makes their
// output capturable in tests. Installed once at the root so it is available to
// every command beneath it.
export function withJsonRenderer(io: AppIO): Middleware {
  const renderer = {
    renderJson: (data: unknown) => renderJson(data, (line) => io.stdout.write(line + "\n")),
    renderJsonLine: (data: unknown) => io.stdout.write(JSON.stringify(data) + "\n"),
  };

  return (h) => ({
    name: () => h.name(),
    description: () => h.description(),
    flags: () => h.flags(),
    arguments: () => h.arguments(),
    doesSupportTui: () => h.doesSupportTui(),
    children: () => h.children(),
    handle: async (ctx, flags, args) => {
      await h.handle(ctx.withValue(JsonRendererKey, renderer), flags, args);
    },
  });
}
