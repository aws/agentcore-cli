import { Router } from "../../router";
import { checkPort, openBrowser, startHttpServer, watchFile, type AppIO } from "../../io";
import { CodeZipDevRunner } from "../../core/dev/codezip";
import { ContainerDevRunner } from "../../core/dev/container";
import { InspectorAssets } from "../../core/dev/inspectorAssets";
import { startOtelCollector } from "../../core/dev/otel/collector";
import { withProject, withTuiWhenInteractive } from "../../middleware";
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
  // The subcommands with a screen of their own. Every other subcommand is
  // listed in the menu as command line only and opens its help instead (see
  // CliOnlyScreen). `add` is a group: it has the resource menu, and which of
  // its resources have a wizard is declared on that router.
  const project = new Router("project", "manage an AgentCore project").supportedTuiCommands(
    "create",
    "invoke",
    "build",
    "deploy",
    "status",
    "add",
  );

  // Without a default, a bare `agentcore project` falls back to Commander's help
  // and a usage exit code instead of the menu every sibling router opens.
  project.default(renderTui(core, io));

  // A bare `agentcore project create` in an interactive session opens the TUI
  // create wizard; any user-supplied flag, --json, or a non-TTY invocation keeps
  // the headless handler (see withTuiWhenInteractive).
  const tuiWhenInteractive = withTuiWhenInteractive(core, io);
  project.handler(tuiWhenInteractive(createCreateProjectHandler({ projectManager, io })));
  project.handler(createAddProjectResourceHandler(config, core));
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
  // A bare `agentcore project status` in an interactive session opens the TUI
  // linked-resources screen; any user-supplied flag, --json, or a non-TTY
  // invocation keeps the headless JSON report. withProject stays outermost so
  // the not-found guidance outside a project is the CLI's own, and the resolved
  // project seeds the screen via ProjectKey.
  project.handler(
    withProject({ projectManager: config.projectManager })(
      tuiWhenInteractive(createStatusProjectHandler({ projectManager: config.projectManager })),
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
