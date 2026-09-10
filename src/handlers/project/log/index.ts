import type { AppIO } from "../../../io";
import { withProject } from "../../../middleware";
import { Router } from "../../../router";
import type { Core } from "../../types";
import { createProjectHarnessLogHandler } from "./harness";
import { createProjectRuntimeLogHandler } from "./runtime";

export function createProjectLogHandler(core: Core, io: AppIO): Router {
  return new Router("log", "inspect logs for resources in the current project")
    .use(withProject({ projectManager: core.projectManager }))
    .handler(createProjectRuntimeLogHandler(core, io))
    .handler(createProjectHarnessLogHandler(core, io));
}
