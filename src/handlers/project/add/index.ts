import { withProject } from "../../../middleware/";
import { Router } from "../../../router";
import { createAddConfigBundleHandler } from "./config-bundle";
import { createAddCredentialsHandler } from "./credentials";
import { createAddHarnessHandler } from "./harness";
import { createAddOnlineEvalHandler } from "./online-eval";
import type { AddProjectResourceConfig } from "./types";

export function createAddProjectResourceHandler(config: AddProjectResourceConfig): Router {
  const projectAdd = new Router("add", "add project resources");
  projectAdd.use(withProject({ projectManager: config.projectManager, cwd: process.cwd() }));
  projectAdd.handler(createAddConfigBundleHandler(config));
  projectAdd.handler(createAddHarnessHandler(config));
  projectAdd.handler(createAddOnlineEvalHandler(config));
  projectAdd.handler(createAddCredentialsHandler(config));
  return projectAdd;
}
