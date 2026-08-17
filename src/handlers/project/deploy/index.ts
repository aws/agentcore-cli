import z from "zod";
import { createHandler, flag, ProjectKey } from "../../../router";
import type { AppIO } from "../../../io";
import { detailedLogLocation } from "../../../logging";
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

      // Progress goes to stderr, keeping stdout for machine output. The CDK toolkit's
      // own narration goes to the log instead, so a deploy shows its steps and
      // nothing else.
      try {
        for await (const event of config.projectManager.deploy(project, {
          region: ctx.require(RegionKey),
          skipBootstrap: flags["skip-bootstrap"],
          target: flags.target,
        })) {
          config.io.stderr.write(`${event.message}\n`);
        }

        config.io.stderr.write(`Deployed project '${project.name}'\n`);
      } finally {
        // Printed however the deploy ended: a failed one is when the detail the log
        // holds matters most, and the error itself surfaces after this line.
        config.io.stderr.write(`Detailed logs: ${detailedLogLocation()}\n`);
      }
    },
  });
