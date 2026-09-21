import z from "zod";
import { DEFAULT_TARGET_NAME } from "../../../projectSchemas/aws-targets";
import { createHandler, flag, ProjectKey, type Middleware } from "../../../router";
import { JsonRendererKey } from "../../../tui";
import { parseArn } from "../../../core/arn";
import type { DeployableResource, ProjectManager, ResolvedProjectResource } from "../types";

type StatusProjectHandlerConfig = {
  projectManager: ProjectManager;
  middlewares?: Middleware[];
};

type ProjectStatus = {
  projectName: string;
  target: string;
  region: string;
  resources: ProjectStatusResource[];
};

type ProjectStatusResource = {
  resourceType: DeployableResource;
  name: string;
  children?: ProjectStatusResource[];
} & (
  | { deploymentState: "deployed"; arn: string }
  | { deploymentState: "deployed"; id: string }
  | { deploymentState: "local-only" }
);

function toProjectStatusResource(resource: ResolvedProjectResource): ProjectStatusResource {
  const base = {
    resourceType: resource.resourceType,
    name: resource.name,
    ...(resource.children && {
      children: resource.children.map(toProjectStatusResource),
    }),
  };

  if (resource.deploymentState === "local-only") {
    return { ...base, deploymentState: resource.deploymentState };
  }

  return {
    ...base,
    deploymentState: resource.deploymentState,
    ...(parseArn(resource.id) ? { arn: resource.id } : { id: resource.id }),
  };
}

export const createStatusProjectHandler = (config: StatusProjectHandlerConfig) =>
  createHandler({
    name: "status",
    description: "show the status of the project's deployed resources",
    middlewares: config.middlewares,
    flags: [
      flag(
        "target",
        "name of the aws-targets.json entry to report on",
        z.string().default(DEFAULT_TARGET_NAME),
      ),
    ],
    handle: async (ctx, flags) => {
      const project = ctx.require(ProjectKey);
      const resolved = await config.projectManager.resolveProjectResources(project, {
        target: flags.target,
      });

      const status: ProjectStatus = {
        projectName: project.name,
        target: resolved.target.name,
        region: resolved.target.region,
        resources: resolved.resources.map(toProjectStatusResource),
      };

      ctx.require(JsonRendererKey).renderJson(status);
    },
  });
