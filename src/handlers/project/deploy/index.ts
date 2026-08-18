import z from "zod";
import { createHandler, flag, LoggerKey, ProjectKey } from "../../../router";
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
    ],
    handle: async (ctx, flags) => {
      const project = ctx.require(ProjectKey);

      // The log is the record of a deploy, so what the deploy shows is written there too,
      // interleaved with the deployment tooling's own narration: reading the log alone is
      // then enough to see which step the hundreds of lines under it belong to.
      const logger = ctx.require(LoggerKey).child({ project: project.name, target: flags.target });

      // Progress goes to stderr, keeping stdout for machine output. The deployment
      // tooling's own narration goes to the log, so a deploy shows only its steps.
      try {
        let outputs: Record<string, string> = {};
        for await (const event of config.projectManager.deploy(project, {
          region: ctx.require(RegionKey),
          target: flags.target,
        })) {
          if (event.kind === "outputs") {
            // Held back until the deploy has succeeded: they belong with the result, not
            // in the middle of the steps still running.
            outputs = event.outputs;
            continue;
          }
          logger.info(event.message);
          config.io.stderr.write(`${event.message}\n`);
        }

        // The outputs are logged as they are reported rather than as the lines below print
        // them, so a later run can be compared against this one.
        logger.child({ outputs }).info("deployed project");
        config.io.stderr.write(`Deployed project '${project.name}'\n`);

        // The stack's outputs are what the deploy created — endpoints, ARNs, ids — and
        // are the reason to read the end of a deploy. Sorted so a stack's outputs are
        // listed the same way every run.
        for (const [key, value] of Object.entries(outputs).sort(([a], [b]) => a.localeCompare(b))) {
          config.io.stderr.write(`  ${key}: ${value}\n`);
        }
      } finally {
        // Printed however the deploy ended: a failed one is when the detail matters most.
        config.io.stderr.write(`Detailed logs: ${detailedLogLocation()}\n`);
      }
    },
  });
