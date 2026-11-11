import { withProject } from "../../../middleware/";
import { Router } from "../../../router";
import { createExportHarnessHandler } from "./harness";
import type { ExportProjectResourceConfig } from "./types";

export function createExportProjectResourceHandler(config: ExportProjectResourceConfig): Router {
  const projectExport = new Router(
    "export",
    "convert project resources into editable code you own",
  );
  projectExport.use(withProject({ projectManager: config.projectManager, optional: true }));
  projectExport.handler(createExportHarnessHandler(config));
  return projectExport;
}
