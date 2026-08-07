import { createHandler } from "../../../router";
import type { AppIO } from "../../../io";
import { RegionKey } from "../../keys";
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
      // Progress and streamed CDK output go to stderr, keeping stdout for
      // machine output.
      for await (const event of config.projectManager.build({
        path: process.cwd(),
        region: ctx.require(RegionKey),
      })) {
        if (event.message) {
          config.io.stderr.write(`${event.message}\n`);
        }
        if (event.subprocessOutput) {
          config.io.stderr.write(event.subprocessOutput);
        }
      }

      config.io.stderr.write(`Build complete\n`);
    },
  });
