import { type Handler } from "../../router";
import { checkPort, openBrowser, startHttpServer, watchFile, type AppIO } from "../../io";
import { CodeZipDevRunner } from "../../core/dev/codezip";
import { ContainerDevRunner } from "../../core/dev/container";
import { InspectorAssets } from "../../core/dev/inspectorAssets";
import { startOtelCollector } from "../../core/dev/otel/collector";
import { withProject, withTuiWhenInteractive } from "../../middleware";
import type { Core } from "../types";
import { createCreateProjectHandler } from "./create";
import { createRemoveProjectHandler } from "./remove";
import { createDevProjectHandler } from "./dev";
import { loadDevEnvironment } from "./dev/environment";
import { createDeployProjectHandler } from "./deploy";
import { createStatusProjectHandler } from "./status";
import { createBuildProjectHandler } from "./build";
import type { ProjectManager } from "./types";
import { createAddProjectResourceHandler } from "./add";
import { createExportProjectResourceHandler } from "./export";
import { createProjectInvokeHandler } from "./invoke";
import { createProjectLogsHandler } from "./logs";
import { createProjectTracesHandler } from "./traces";

export function createProjectHandlers(core: Core, io: AppIO): Handler[] {
  const projectManager: ProjectManager = core.projectManager;

  const createHandler = createCreateProjectHandler({
    projectManager,
    io,
    middlewares: [withTuiWhenInteractive(core, io)],
  });

  const withProjectMiddleware = withProject({ projectManager });
  const config = { projectManager, io, bedrockAgentImporter: core.bedrockAgentImporter };
  // Returned in workflow order, which is the order `--help` and the TUI menu list them in:
  // the inner loop (dev, deploy, invoke), then observing it, then changing the project.
  // build is a step deploy already runs, so it goes last and the TUI menu hides it.
  const projectBoundHandlers = [
    createDevProjectHandler({
      projectManager,
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
      middlewares: [withProjectMiddleware],
    }),
    createProjectInvokeHandler(core, io),
    createStatusProjectHandler({
      projectManager,
      middlewares: [withProjectMiddleware, withTuiWhenInteractive(core, io)],
    }),
    createProjectLogsHandler(core, io),
    createProjectTracesHandler(core, io),
    createAddProjectResourceHandler(config, core),
    createRemoveProjectHandler({
      projectManager,
      io,
      middlewares: [withProjectMiddleware, withTuiWhenInteractive(core, io)],
    }),
    createExportProjectResourceHandler({ projectManager, core, io }),
    createBuildProjectHandler({
      projectManager,
      io,
      middlewares: [withProjectMiddleware],
    }),
  ];

  return [createHandler, ...projectBoundHandlers];
}
