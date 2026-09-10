import type { AppIO } from "../../../io";
import { withProject } from "../../../middleware";
import { Router } from "../../../router";
import type { Core } from "../../types";
import { createProjectRuntimeTracesHandler } from "./runtime";

export function createProjectTracesHandler(core: Core, io: AppIO): Router {
  return new Router("traces", "inspect traces for resources in the current project")
    .use(withProject({ projectManager: core.projectManager }))
    .handler(createProjectRuntimeTracesHandler(core, io));
}
