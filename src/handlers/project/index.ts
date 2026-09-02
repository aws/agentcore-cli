import { Router, type Handler } from "../../router";
import { checkPort, openBrowser, startHttpServer, watchFile, type AppIO } from "../../io";
import { CodeZipDevRunner } from "../../core/dev/codezip";
import { ContainerDevRunner } from "../../core/dev/container";
import { InspectorAssets } from "../../core/dev/inspectorAssets";
import { startOtelCollector } from "../../core/dev/otel/collector";
import { withProject, withTuiOnEmptyFlagsAndArgs } from "../../middleware";
import { renderTui } from "../../tui";
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

type ProjectHandlerConfig = {
  core: Core;
  io: AppIO;
};

export function createProjectHandler({ core, io }: ProjectHandlerConfig): Router {
  const projectManager: ProjectManager = core.projectManager;
  const config = { projectManager, io, bedrockAgentImporter: core.bedrockAgentImporter };
  const project = new Router("project", "manage an AgentCore project");

  // Without a default, a bare `agentcore project` falls back to Commander's help
  // and a usage exit code instead of the menu every sibling router opens.
  project.default(renderTui(core, io));

  // A bare `agentcore project create` in an interactive session opens the TUI
  // create wizard; any user-supplied flag or --json keeps the headless handler.
  // The TTY gate wraps the middleware (rather than living inside it) so a
  // piped/CI invocation also stays headless and reports the missing --name as
  // a usage error instead of renderTui's "interactive mode requires a TTY".
  const createProject = createCreateProjectHandler({
    projectManager,
    io,
    bedrockAgentImporter: core.bedrockAgentImporter,
  });
  const createProjectWithWizard = withTuiOnEmptyFlagsAndArgs(core, io)(createProject);
  const isInteractive = () => io.stdin.isTTY === true && io.stdout.isTTY === true;
  const createProjectDispatch: Handler = {
    name: () => createProject.name(),
    description: () => createProject.description(),
    flags: () => createProject.flags(),
    arguments: () => createProject.arguments(),
    doesSupportTui: () => createProject.doesSupportTui(),
    children: () => createProject.children(),
    handle: (ctx, flags, args) =>
      isInteractive()
        ? createProjectWithWizard.handle(ctx, flags, args)
        : createProject.handle(ctx, flags, args),
  };
  project.handler(createProjectDispatch);
  project.handler(createAddProjectResourceHandler(config));
  project.handler(createExportProjectResourceHandler({ projectManager, core, io }));
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
        projectManager: config.projectManager,
      }),
    ),
  );
  project.handler(
    withProject({ projectManager: config.projectManager })(
      createDeployProjectHandler({ projectManager: config.projectManager, io: config.io }),
    ),
  );
  project.handler(createProjectInvokeHandler(core, io));
  project.handler(
    withProject({ projectManager: config.projectManager })(
      createStatusProjectHandler({ projectManager: config.projectManager }),
    ),
  );
  // withProject wraps only the commands that require an existing project, so
  // `create` (which refuses to nest inside one) stays unaffected.
  project.handler(
    withProject({ projectManager: config.projectManager })(
      createBuildProjectHandler({ projectManager: config.projectManager, io: config.io }),
    ),
  );

  return project;
}
