import { withProject } from "../../../middleware/";
import { Router } from "../../../router";
import { createAddHarnessHandler } from "./harness";
import type { AddProjectResourceConfig } from "./types";

export function createAddProjectResourceHandler(config: AddProjectResourceConfig): Router {
  const projectAdd = new Router("add", "add project resources");
  projectAdd.use(withProject({ projectManager: config.projectManager, cwd: process.cwd() }));
  projectAdd.handler(createAddHarnessHandler(config));
  return projectAdd;
}
