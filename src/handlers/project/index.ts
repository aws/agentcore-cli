import { Router } from "../../router";
import { checkPort, openBrowser, startHttpServer, watchFile, type AppIO } from "../../io";
import { CodeZipDevRunner } from "../../core/dev/codezip";
import { ContainerDevRunner } from "../../core/dev/container";
import { InspectorAssets } from "../../core/dev/inspectorAssets";
import { startOtelCollector } from "../../core/dev/otel/collector";
import { withProject } from "../../middleware";
import { createCreateProjectHandler } from "./create";
import { createRemoveProjectHandler } from "./remove";
import { createDevProjectHandler } from "./dev";
import { loadDevEnvironment } from "./dev/environment";
import { createDeployProjectHandler } from "./deploy";
import { createStatusProjectHandler } from "./status";
import { createBuildProjectHandler } from "./build";
import type { ProjectManager } from "./types";
import { createAddProjectResourceHandler } from "./add";

type ProjectHandlerConfig = {
  projectManager: ProjectManager;
  io: AppIO;
};

export function createProjectHandler(config: ProjectHandlerConfig): Router {
  const project = new Router("project", "manage an AgentCore project");

  project.handler(
    createCreateProjectHandler({ projectManager: config.projectManager, io: config.io }),
  );
  project.handler(createAddProjectResourceHandler(config));
  project.handler(
    withProject({ projectManager: config.projectManager })(
      createRemoveProjectHandler({ projectManager: config.projectManager, io: config.io }),
    ),
  );
  project.handler(
    withProject({ projectManager: config.projectManager })(
      createDevProjectHandler({
        io: config.io,
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
        reloadRuntimes: async (projectRoot) => {
          const project = await config.projectManager.resolve({ filePath: projectRoot });
          if (!project) throw new Error("project configuration is currently unreadable");
          return project.spec.runtimes;
        },
      }),
    ),
  );
  project.handler(
    withProject({ projectManager: config.projectManager })(
      createDeployProjectHandler({ projectManager: config.projectManager, io: config.io }),
    ),
  );
  project.handler(createStatusProjectHandler());
  // withProject wraps only the commands that require an existing project, so
  // `create` (which refuses to nest inside one) stays unaffected.
  project.handler(
    withProject({ projectManager: config.projectManager })(
      createBuildProjectHandler({ projectManager: config.projectManager, io: config.io }),
    ),
  );

  return project;
}
