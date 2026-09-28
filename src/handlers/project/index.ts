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
import { createProjectLogHandler } from "./log";
import { createProjectTracesHandler } from "./traces";

export function createProjectHandlers(
  core: Core,
  io: AppIO,
): { createHandler: Handler; projectBoundHandlers: Handler[] } {
  const projectManager: ProjectManager = core.projectManager;

  const createHandler = createCreateProjectHandler({
    projectManager,
    io,
    middlewares: [withTuiWhenInteractive(core, io)],
  });

  const withProjectMiddleware = withProject({ projectManager });
  const config = { projectManager, io, bedrockAgentImporter: core.bedrockAgentImporter };
  const projectBoundHandlers = [
    createAddProjectResourceHandler(config, core),
    createExportProjectResourceHandler({ projectManager, core, io }),
    createRemoveProjectHandler({
      projectManager,
      io,
      middlewares: [withProjectMiddleware, withTuiWhenInteractive(core, io)],
    }),
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
    createProjectLogHandler(core, io),
    createProjectTracesHandler(core, io),
    createStatusProjectHandler({
      projectManager,
      middlewares: [withProjectMiddleware, withTuiWhenInteractive(core, io)],
    }),
    createBuildProjectHandler({
      projectManager,
      io,
      middlewares: [withProjectMiddleware],
    }),
  ];

  return { createHandler, projectBoundHandlers };
}
