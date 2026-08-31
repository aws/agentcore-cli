import { withProject } from "../../../middleware/";
import { Router } from "../../../router";
import { createExportHarnessHandler } from "./harness";
import type { ExportProjectResourceConfig } from "./types";

export function createExportProjectResourceHandler(config: ExportProjectResourceConfig): Router {
  const projectExport = new Router(
    "export",
    "convert project resources into editable code you own",
  );
  // The project is resolved and validated up front, so `--arn` never fetches
  // from the service on behalf of a directory that is not a valid project.
  // No pinned cwd: the invocation-time working directory is the one searched.
  projectExport.use(withProject({ projectManager: config.projectManager }));
  projectExport.handler(createExportHarnessHandler(config));
  return projectExport;
}
