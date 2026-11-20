import { type Handler } from "../../router";
import {
  checkPort,
  openBrowser,
  runInheritedProcess,
  startHttpServer,
  watchFile,
  type AppIO,
} from "../../io";
import { CodeZipDevRunner } from "../../core/dev/codezip";
import { ContainerDevRunner } from "../../core/dev/container";
import { InspectorAssets } from "../../core/dev/inspectorAssets";
import { startOtelCollector } from "../../core/dev/otel/collector";
import { withProject, withTuiWhenInteractive, withV0ProjectGuard } from "../../middleware";
import type { Core } from "../types";
import { createCreateProjectHandler } from "./create";
import { createRemoveProjectHandler } from "./remove";
import { createDevProjectHandler } from "./dev";
import { loadDevEnvironment } from "./dev/environment";
import { createDeployProjectHandler } from "./deploy";
import { createStatusProjectHandler } from "./status";
import { createBuildProjectHandler } from "./build";
import { createMigrateProjectHandler } from "./migrate";
import type { ProjectManager } from "./types";
import { createAddProjectResourceHandler } from "./add";
import { createExportProjectResourceHandler } from "./export";
import { createProjectInvokeHandler } from "./invoke";
import { createProjectLogsHandler } from "./logs";
import { createProjectTracesHandler } from "./traces";
import { executeV0Deploy, type V0DeployRunner } from "../../core/project/legacy/deploy";

export type ProjectHandlerOptions = {
  runV0Deploy?: V0DeployRunner;
};

export function createProjectHandlers(
  core: Core,
  io: AppIO,
  options: ProjectHandlerOptions = {},
): Handler[] {
  const projectManager: ProjectManager = core.projectManager;
  const runLegacyDeploy =
    options.runV0Deploy ?? ((input) => executeV0Deploy(input, runInheritedProcess));

  const createHandler = createCreateProjectHandler({
    projectManager,
    io,
    middlewares: [withTuiWhenInteractive(core, io)],
  });

  const withProjectMiddleware = withProject({ projectManager });
  const config = { projectManager, io, bedrockAgentImporter: core.bedrockAgentImporter };
  // Returned in workflow order, which is the order `--help` and the TUI menu list them in:
  // create/configure, run/deploy, observe, then one-off project maintenance.
  // build is a step deploy already runs, so it goes last and the TUI menu hides it.
  const projectBoundHandlers = [
    createAddProjectResourceHandler(config, core),
    createDevProjectHandler({
      projectManager,
      runV0Deploy: runLegacyDeploy,
      harness: core.harness,
      io,
      middlewares: [withProjectMiddleware],
      runners: {
        CodeZip: new CodeZipDevRunner(),
        Container: new ContainerDevRunner(),
      },
      loadDevEnvironment,
      checkPort,
      startTraceCollector: startOtelCollector,
      startServer: startHttpServer,
      openBrowser,
      inspectorAssets: new InspectorAssets(),
      isInteractive: () => process.stdout.isTTY === true,
      watchFile,
    }),
    createDeployProjectHandler({
      projectManager,
      io,
      runV0Deploy: runLegacyDeploy,
      middlewares: [withProjectMiddleware],
    }),
    createProjectInvokeHandler(core, io),
    createStatusProjectHandler({
      projectManager,
      io,
      middlewares: [withProjectMiddleware, withTuiWhenInteractive(core, io)],
    }),
    createProjectLogsHandler(core, io),
    createProjectTracesHandler(core, io),
    createExportProjectResourceHandler({ projectManager, core, io }),
    createMigrateProjectHandler({ projectManager, migrator: core.projectMigrator, io }),
    createRemoveProjectHandler({
      projectManager,
      io,
      middlewares: [withV0ProjectGuard(), withProjectMiddleware, withTuiWhenInteractive(core, io)],
    }),
    createBuildProjectHandler({
      projectManager,
      io,
      middlewares: [withProjectMiddleware],
    }),
  ];

  return [createHandler, ...projectBoundHandlers];
}
