import { Router } from "../router";
import { createHarnessHandler } from "./harness/index.tsx";
import { createRuntimeHandler } from "./runtime/index.tsx";
import { DebugKey, EndpointKey, JsonKey, RegionKey } from "./keys.tsx";
import { createConfigHandler } from "./config/";
import { createProjectHandler } from "./project/index.ts";
import { renderTui } from "../tui";
import { withRegion, withJsonRenderer, withLogging } from "../middleware";
import type { AppIO, Core } from "./types.tsx";
import type { Logger } from "../logging";

export interface RootHandlerConfig {
  io: AppIO;
  logger: Logger;
}

export function createRootHandler(core: Core, config: RootHandlerConfig): Router {
  const { io, logger } = config;
  const root = new Router("agentcore", "the platform for production AI agents");

  // Add global flags
  root.groupFlags(RegionKey, DebugKey, JsonKey, EndpointKey);

  // Resolve the effective AWS region (flag -> env -> config file) and pin it on
  // the context for every command beneath the root.
  root.use(withRegion());

  // Pin a JSON renderer wired to the configured stdout so leaf handlers can emit
  // machine-readable output without touching the process streams directly.
  root.use(withJsonRenderer(io));

  // Inject a logger into each handler.
  root.use(withLogging({ logger }));

  // Install sub handlers
  root.handler(createHarnessHandler(core, io));
  root.handler(createRuntimeHandler(core, io));
  root.handler(createConfigHandler(io));
  root.handler(createProjectHandler());

  // Invoking with no subcommand launches the interactive TUI.
  root.default(renderTui(core, io));

  return root;
}
