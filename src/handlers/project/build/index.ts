import { createHandler, ProjectKey } from "../../../router";
import type { AppIO } from "../../../io";
import { JsonRendererKey } from "../../../tui";
import { runWithProgress } from "../../../tui/progress";
import { JsonKey } from "../../keys";
import { renderJsonError } from "../../utils";
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
      const jsonOutput = ctx.require(JsonKey);

      // Progress goes to stderr, keeping stdout for machine output. In a TTY
      // the driver renders the live step list; otherwise it writes plain lines
      // and the subprocess output stays in the debug log (ProcessFailedError
      // carries it on failure). --json forces the plain path so no ANSI
      // reaches a scripted caller's stderr.
      try {
        await runWithProgress(config.projectManager.build(project), {
          io: config.io,
          interactive: jsonOutput ? false : undefined,
        });
      } catch (error) {
        if (jsonOutput) renderJsonError(ctx, error);
        throw error;
      }

      const message = `Built project '${project.name}'`;
      config.io.stderr.write(`${message}\n`);
      if (jsonOutput) ctx.require(JsonRendererKey).renderJson({ message });
    },
  });
