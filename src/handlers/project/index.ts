import { Router } from "../../router";
import { createCreateProjectHandler } from "./create";

export function createProjectHandler(): Router {
  const project = new Router("project", "manage an AgentCore project");

  project.handler(createCreateProjectHandler());

  return project;
}
