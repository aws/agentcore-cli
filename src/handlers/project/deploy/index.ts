import z from "zod";
import type { AppIO } from "../../../io";
import { createHandler, flag, ProjectKey } from "../../../router";
import { JsonRendererKey } from "../../../tui";
import { JsonKey } from "../../keys";
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
      flag("target", "name of the aws-targets.json entry to deploy", z.string().default("default")),
      flag(
        "yes",
        "confirm removing the target's stack when the project declares nothing to deploy",
        z.boolean().default(false),
      ),
    ],
    handle: async (ctx, flags) => {
      // withProject has already resolved the enclosing project.
      const project = ctx.require(ProjectKey);

      // Progress goes to stderr, keeping stdout for machine output. Driven by
      // hand rather than `for await` because the outputs we render below are the
      // generator's return value, which `for await` discards.
      const deployment = config.projectManager.deploy(project, {
        target: flags.target,
        confirmTeardown: flags.yes,
      });
      let next = await deployment.next();
      while (!next.done) {
        config.io.stderr.write(`${next.value.message}\n`);
        next = await deployment.next();
      }
      const result = next.value;

      config.io.stderr.write(
        result.tornDown
          ? `Removed project '${project.name}' from target '${flags.target}'\n`
          : `Deployed project '${project.name}' to target '${flags.target}'\n`,
      );
      if (ctx.require(JsonKey)) {
        ctx.require(JsonRendererKey).renderJson(result);
        return;
      }
      for (const [key, value] of Object.entries(result.outputs).sort(([a], [b]) =>
        a.localeCompare(b),
      )) {
        config.io.stdout.write(`${key}: ${value}\n`);
      }
    },
  });
