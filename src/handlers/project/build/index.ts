import { createHandler, ProjectKey } from "../../../router";
import type { AppIO } from "../../../io";
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

      // Progress goes to stderr, keeping stdout for machine output. Subprocess
      // output goes to the debug log; on failure ProcessFailedError carries it.
      for await (const event of config.projectManager.build(project)) {
        config.io.stderr.write(`${event.message}\n`);
      }

      config.io.stderr.write(`Built project '${project.name}'\n`);
    },
  });
