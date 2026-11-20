import { Router } from "../../../router";
import type { AppIO } from "../../../io";
import type { Core } from "../../types";
import { createHelpDefault } from "../../help";
import { createDeleteDatasetGenerationHandler } from "./delete";
import { createGetDatasetGenerationHandler } from "./get";
import { createListDatasetGenerationsHandler } from "./list";
import { createStartDatasetGenerationHandler } from "./start";

// dataset-generation ships headless, so a bare invocation prints help, as ondemand does.
export function createDatasetGenerationHandler(core: Core, io: AppIO): Router {
  return new Router("dataset-generation", "generate dataset examples from agent traces")
    .default(createHelpDefault(io))
    .handler(createStartDatasetGenerationHandler(core, io))
    .handler(createGetDatasetGenerationHandler(core))
    .handler(createListDatasetGenerationsHandler(core))
    .handler(createDeleteDatasetGenerationHandler(core));
}
