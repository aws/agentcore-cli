import { Router } from "../../../router";
import type { AppIO } from "../../../io";
import type { Core } from "../../types";
import { createHelpDefault } from "../../help";
import { createCreateConfigBundleHandler } from "./create";
import { createDeleteConfigBundleHandler } from "./delete";
import { createGetConfigBundleHandler } from "./get";
import { createListConfigBundlesHandler } from "./list";
import { createUpdateConfigBundleHandler } from "./update";
import { createConfigBundleVersionHandler } from "./version";

export function createConfigBundleHandler(core: Core, io: AppIO): Router {
  return new Router("config-bundle", "manage AgentCore configuration bundles")
    .default(createHelpDefault(io))
    .handler(createCreateConfigBundleHandler(core, io))
    .handler(createGetConfigBundleHandler(core))
    .handler(createListConfigBundlesHandler(core))
    .handler(createUpdateConfigBundleHandler(core, io))
    .handler(createDeleteConfigBundleHandler(core))
    .handler(createConfigBundleVersionHandler(core, io));
}
