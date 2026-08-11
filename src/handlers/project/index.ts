import { Router } from "../../router";
import type { AppIO } from "../../io";
import { createCreateProjectHandler } from "./create";
import { createRemoveProjectHandler } from "./remove";
import { createDevProjectHandler } from "./dev";
import { createDeployProjectHandler } from "./deploy";
import { createStatusProjectHandler } from "./status";
import { createBuildProjectHandler } from "./build";
import type { ProjectManager } from "./types";
import { createAddProjectResourceHandler } from "./add";

type ProjectHandlerConfig = {
  projectManager: ProjectManager;
  io: AppIO;
};

export function createProjectHandler(config: ProjectHandlerConfig): Router {
  const project = new Router("project", "manage an AgentCore project");

  project.handler(
    createCreateProjectHandler({ projectManager: config.projectManager, io: config.io }),
  );
  project.handler(createAddProjectResourceHandler(config));
  project.handler(createRemoveProjectHandler());
  project.handler(createDevProjectHandler());
  project.handler(createDeployProjectHandler());
  project.handler(createStatusProjectHandler());
  project.handler(createBuildProjectHandler());

  return project;
}
