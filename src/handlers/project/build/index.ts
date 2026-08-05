import { createHandler } from "../../../router";
import type { AppIO } from "../../../io";
import { JsonRendererKey } from "../../../tui";
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
      const result = await config.projectManager.build({
        filePath: process.cwd(),
        onProgress: (event) => config.io.stderr.write(`${event.message}\n`),
      });
      ctx.require(JsonRendererKey).renderJson(result);
    },
  });
