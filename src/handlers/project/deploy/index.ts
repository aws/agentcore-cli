import z from "zod";
import { createHandler, flag } from "../../../router";
import type { AppIO } from "../../../io";
import { RegionKey } from "../../keys";
import type { ProjectManager } from "../types";

type DeployProjectHandlerConfig = {
  projectManager: ProjectManager;
  io: AppIO;
};

export const createDeployProjectHandler = (config: DeployProjectHandlerConfig) =>
  createHandler({
    name: "deploy",
    description: "deploy the project to AWS",
    flags: [
      flag(
        "skip-bootstrap",
        "skip bootstrapping the target environments before deploying",
        z.boolean().default(false),
      ),
    ],
    handle: async (ctx, flags) => {
      // Progress and streamed CDK output go to stderr, keeping stdout for
      // machine output.
      for await (const event of config.projectManager.deploy({
        path: process.cwd(),
        region: ctx.require(RegionKey),
        skipBootstrap: flags["skip-bootstrap"],
      })) {
        if (event.message) {
          config.io.stderr.write(`${event.message}\n`);
        }
        if (event.subprocessOutput) {
          config.io.stderr.write(event.subprocessOutput);
        }
      }

      config.io.stderr.write(`Deploy complete\n`);
    },
  });
