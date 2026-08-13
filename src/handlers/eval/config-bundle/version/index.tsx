import { Router } from "../../../../router";
import type { AppIO } from "../../../../io";
import type { Core } from "../../../types";
import { createHelpDefault } from "../../../help";
import { createListConfigBundleVersionsHandler } from "./list";

export function createConfigBundleVersionHandler(core: Core, io: AppIO): Router {
  return new Router("version", "inspect immutable configuration bundle versions")
    .default(createHelpDefault(io))
    .handler(createListConfigBundleVersionsHandler(core));
}
