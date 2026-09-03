import { renderTui } from "../../../tui";
import { Router } from "../../../router";
import type { AppIO } from "../../../io";
import type { Core } from "../../types";
import { createGetVersionHandler } from "./get";
import { createListVersionsHandler } from "./list";

export function createVersionHandler(core: Core, io: AppIO): Router {
  const version = new Router("version", "inspect harness versions");

  // Open the TUI at this root, i.e., `agentcore harness version`. Leaves
  // inherit the harness router's TUI-on-empty-flags middleware.
  version.default(renderTui(core, io));

  // Register handlers
  version.handler(createGetVersionHandler(core));
  version.handler(createListVersionsHandler(core));

  return version;
}

export { HarnessVersionScreen } from "./screen.tsx";
