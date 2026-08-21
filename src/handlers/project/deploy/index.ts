import z from "zod";
import type { AppIO } from "../../../io";
import { createHandler, flag, ProjectKey } from "../../../router";
import { JsonRendererKey } from "../../../tui";
import { JsonKey } from "../../keys";
import type { DeployResult, ProjectManager } from "../types";

type DeployProjectHandlerConfig = {
  projectManager: ProjectManager;
  io: AppIO;
};

async function runDeploy(
  config: DeployProjectHandlerConfig,
  project: Parameters<ProjectManager["deploy"]>[0],
  target: string,
): Promise<DeployResult> {
  const deployment = config.projectManager.deploy(project, { target });
  let next = await deployment.next();
  while (!next.done) {
    config.io.stderr.write(`${next.value.message}\n`);
    next = await deployment.next();
  }
  return next.value;
}

function renderResult(io: AppIO, result: DeployResult): void {
  for (const [key, value] of Object.entries(result.outputs).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    io.stdout.write(`${key}: ${value}\n`);
  }
}

export const createDeployProjectHandler = (config: DeployProjectHandlerConfig) =>
  createHandler({
    name: "deploy",
    description: "deploy the project to AWS",
    flags: [
      flag("target", "name of the aws-targets.json entry to deploy", z.string().default("default")),
    ],
    handle: async (ctx, flags) => {
      const project = ctx.require(ProjectKey);
      const result = await runDeploy(config, project, flags.target);

      config.io.stderr.write(`Deployed project '${project.name}' to target '${flags.target}'\n`);
      if (ctx.require(JsonKey)) {
        ctx.require(JsonRendererKey).renderJson(result);
      } else {
        renderResult(config.io, result);
      }
    },
  });
