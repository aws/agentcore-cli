import { withProject } from "../../middleware";
import { Router } from "../../router";
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

  // npm/bun scripts change process.cwd() to the package root; INIT_CWD
  // preserves the directory the user actually ran the command from.
  const cwd = process.env.INIT_CWD ?? process.cwd();

  // Commands that operate on an existing project get it resolved onto the context.
  const inProject = withProject({ projectManager: config.projectManager, cwd });

  project.handler(
    createCreateProjectHandler({ projectManager: config.projectManager, io: config.io }),
  );
  project.handler(inProject(createAddProjectHandler()));
  project.handler(inProject(createRemoveProjectHandler()));
  project.handler(inProject(createDevProjectHandler()));
  project.handler(inProject(createDeployProjectHandler()));
  project.handler(inProject(createStatusProjectHandler()));
  project.handler(inProject(createBuildProjectHandler()));

  return project;
}
