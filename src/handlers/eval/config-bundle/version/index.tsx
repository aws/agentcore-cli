import { Router } from "../../../../router";
import { renderTui } from "../../../../tui";
import { withTuiOnEmptyFlagsAndArgs } from "../../../../middleware";
import type { AppIO } from "../../../../io";
import type { Core } from "../../../types";
import { createListConfigBundleVersionsHandler } from "./list";

export function createConfigBundleVersionHandler(core: Core, io: AppIO): Router {
  return new Router("version", "inspect immutable configuration bundle versions")
    .use(withTuiOnEmptyFlagsAndArgs(core, io))
    .default(renderTui(core, io))
    .supportedTuiCommands("list")
    .handler(createListConfigBundleVersionsHandler(core));
}
