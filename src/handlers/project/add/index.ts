import { withProject } from "../../../middleware/";
import { Router } from "../../../router";
import { createAddCredentialsHandler } from "./credentials";
import { createAddHarnessHandler } from "./harness";
import type { AddProjectResourceConfig } from "./types";

export function createAddProjectResourceHandler(config: AddProjectResourceConfig): Router {
  const projectAdd = new Router("add", "add project resources");
  projectAdd.use(withProject({ projectManager: config.projectManager, cwd: process.cwd() }));
  projectAdd.handler(createAddHarnessHandler(config));
  projectAdd.handler(createAddCredentialsHandler(config));
  return projectAdd;
}
