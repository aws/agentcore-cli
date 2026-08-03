import { Router } from "../../../router";
import type { AppIO } from "../../../io";
import type { Core } from "../../types";
import { createHelpDefault } from "../../help";
import { createCreateDatasetHandler } from "./create";

export function createDatasetHandler(core: Core, io: AppIO): Router {
  return new Router("dataset", "manage AgentCore evaluation datasets")
    .default(createHelpDefault(io))
    .handler(createCreateDatasetHandler(core, io));
}
