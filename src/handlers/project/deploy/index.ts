import z from "zod";
import { createHandler, flag, ProjectKey } from "../../../router";
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
        "target",
        "name of the aws-targets.json entry to deploy to",
        z.string().default("default"),
      ),
      flag(
        "skip-bootstrap",
        "skip bootstrapping the target environment before deploying",
        z.boolean().default(false),
      ),
    ],
    handle: async (ctx, flags) => {
      // withProject has already resolved the enclosing project.
      const project = ctx.require(ProjectKey);

      // Progress and the CDK toolkit's own output both go to stderr, keeping stdout
      // for machine output.
      for await (const event of config.projectManager.deploy(project, {
        region: ctx.require(RegionKey),
        skipBootstrap: flags["skip-bootstrap"],
        target: flags.target,
      })) {
        if (event.message) {
          config.io.stderr.write(`${event.message}\n`);
        }
        if (event.output) {
          config.io.stderr.write(`${event.output}\n`);
        }
      }

      config.io.stderr.write(`Deployed project '${project.name}'\n`);
    },
  });
