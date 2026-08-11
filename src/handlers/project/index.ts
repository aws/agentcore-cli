import { Router } from "../../router";
import { withProject } from "../../middleware";
import type { AppIO } from "../../io";
import { createCreateProjectHandler } from "./create";
import { createAddProjectHandler } from "./add";
import { createRemoveProjectHandler } from "./remove";
import { createDevProjectHandler } from "./dev";
import { createDeployProjectHandler } from "./deploy";
import { createStatusProjectHandler } from "./status";
import { createBuildProjectHandler } from "./build";
import type { ProjectManager } from "./types";

type ProjectHandlerConfig = {
  projectManager: ProjectManager;
  io: AppIO;
};

export function createProjectHandler(config: ProjectHandlerConfig): Router {
  const project = new Router("project", "manage an AgentCore project");

  project.handler(
    createCreateProjectHandler({ projectManager: config.projectManager, io: config.io }),
  );
  project.handler(createAddProjectHandler());
  project.handler(createRemoveProjectHandler());
  project.handler(createDevProjectHandler());
  project.handler(createDeployProjectHandler());
  project.handler(createStatusProjectHandler());
  // withProject wraps only the commands that require an existing project, so
  // `create` (which refuses to nest inside one) stays unaffected.
  project.handler(
    withProject({ projectManager: config.projectManager })(
      createBuildProjectHandler({ projectManager: config.projectManager, io: config.io }),
    ),
  );

  return project;
}
