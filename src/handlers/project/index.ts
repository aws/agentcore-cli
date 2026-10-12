import { type Handler } from "../../router";
import {
  checkPort,
  openBrowser,
  runProcess,
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
  // migrate is a one-off upgrade from a v0 project, so it follows build; it
  // finds the project itself because withProject can't parse a v0 project.
  const projectBoundHandlers = [
    createDevProjectHandler({
      projectManager,
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
      middlewares: [withV0ProjectGuard(), withProjectMiddleware, withTuiWhenInteractive(core, io)],
    }),
    createExportProjectResourceHandler({ projectManager, core, io }),
    createBuildProjectHandler({
      projectManager,
      io,
      middlewares: [withProjectMiddleware],
    }),
    createMigrateProjectHandler({ runner: runProcess }),
  ];

  return [createHandler, ...projectBoundHandlers];
}
