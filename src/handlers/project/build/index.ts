import { createHandler, ProjectKey } from "../../../router";
import type { AppIO } from "../../../io";
import { runWithProgress } from "../../../tui/progress";
import type { ProjectManager } from "../types";

type BuildProjectHandlerConfig = {
  projectManager: ProjectManager;
  io: AppIO;
};

export const createBuildProjectHandler = (config: BuildProjectHandlerConfig) =>
  createHandler({
    name: "build",
    description: "build the project's deployable artifacts",
    handle: async (ctx) => {
      // withProject has already resolved the enclosing project.
      const project = ctx.require(ProjectKey);

      // Progress goes to stderr, keeping stdout for machine output. In a TTY
      // the driver renders the live step list; otherwise it writes plain lines
      // and the subprocess output stays in the debug log (ProcessFailedError
      // carries it on failure).
      await runWithProgress(config.projectManager.build(project), { io: config.io });

      config.io.stderr.write(`Built project '${project.name}'\n`);
    },
  });
