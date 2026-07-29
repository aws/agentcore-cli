import { Router } from "../../router";
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
};

export function createProjectHandler(config: ProjectHandlerConfig): Router {
  const project = new Router("project", "manage an AgentCore project");

  project.handler(createCreateProjectHandler({ projectManager: config.projectManager }));
  project.handler(createAddProjectHandler());
  project.handler(createRemoveProjectHandler());
  project.handler(createDevProjectHandler());
  project.handler(createDeployProjectHandler());
  project.handler(createStatusProjectHandler());
  project.handler(createBuildProjectHandler());

  return project;
}
