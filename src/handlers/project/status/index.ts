import z from "zod";
import { DEFAULT_TARGET_NAME } from "../../../projectSchemas/aws-targets";
import { createHandler, flag, ProjectKey } from "../../../router";
import { JsonRendererKey } from "../../../tui";
import type { ProjectManager, ResolvedProjectResource } from "../types";

type StatusProjectHandlerConfig = {
  projectManager: ProjectManager;
};

type ProjectStatus = {
  projectName: string;
  target: string;
  region: string;
  resources: ResolvedProjectResource[];
};

export const createStatusProjectHandler = (config: StatusProjectHandlerConfig) =>
  createHandler({
    name: "status",
    description: "show the status of the project's deployed resources",
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
        resources: resolved.resources,
      };
      ctx.require(JsonRendererKey).renderJson(status);
    },
  });
