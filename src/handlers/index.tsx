import { Router } from "../router";
import { createEvalHandler } from "./eval/index.tsx";
import { createGatewayHandler } from "./gateway/index.tsx";
import { createHarnessHandler } from "./harness/index.tsx";
import { createIdentityHandler } from "./identity/index.tsx";
import { createMemoryHandler } from "./memory/index.tsx";
import { createRuntimeHandler } from "./runtime/index.tsx";
import { DebugKey, EndpointKey, JsonKey, RegionKey } from "./keys.tsx";
import { createConfigHandler } from "./config/";
import { createProjectHandler } from "./project/index.ts";
import { ObservabilityHandlerFactory } from "./observability/handlerFactory";
import { renderTui } from "../tui";
import { withRegion, withJsonRenderer, withLogging, withGlobalConfigAccessor } from "../middleware";
import type { AppIO } from "../io";
import type { Core } from "./types.tsx";
import type { Logger } from "../logging";
import type { GlobalConfigAccessor } from "../globalConfig";
import { PACKAGE_VERSION } from "../constants";

export interface RootHandlerConfig {
  io: AppIO;
  logger: Logger;
  globalConfigAccessor: GlobalConfigAccessor;
}

export function createRootHandler(core: Core, config: RootHandlerConfig): Router {
  const { io, logger } = config;
  const root = new Router("agentcore", "the platform for production AI agents");
  const observabilityHandlers = new ObservabilityHandlerFactory(core.observability, io);

  // `agentcore --version` prints the build-time package version.
  root.version(PACKAGE_VERSION);

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

  // Pin the global config accessor on the context for any handler that needs it.
  root.use(withGlobalConfigAccessor(config.globalConfigAccessor));

  // Install sub handlers
  root.handler(createHarnessHandler(core, io));
  root.handler(createIdentityHandler(core, io));
  root.handler(createRuntimeHandler(core, io, observabilityHandlers));
  root.handler(createMemoryHandler(core, io));
  root.handler(createGatewayHandler(core, io));
  root.handler(createEvalHandler(core, io));
  root.handler(createConfigHandler());
  root.handler(createProjectHandler({ core, io }));

  // Invoking with no subcommand launches the interactive TUI.
  root.default(renderTui(core, io));

  return root;
}
