import { ProjectKey, type Context } from "../../../router";
import { runWithProgress } from "../../../tui/progress";
import { renderResult } from "../../utils";
import {
  projectMutationResource,
  projectReference,
  type ProjectMutationResourceType,
} from "../output";
import type { AddResourceInput, Project } from "../types";
import type { AddProjectResourceConfig } from "./types";

type AddProjectResourceResultOptions = {
  resourceType?: ProjectMutationResourceType;
};

export async function addProjectResource(
  ctx: Context,
  config: AddProjectResourceConfig,
  input: AddResourceInput,
  humanSuccessMessage: string,
  options: AddProjectResourceResultOptions = {},
): Promise<Project> {
  const project = ctx.require(ProjectKey);
  const updatedProject = await runWithProgress(config.projectManager.addResource(project, input), {
    io: config.io,
    // Project add commands historically print plain progress lines even on a
    // TTY. Keep that behavior while still collecting the generator result.
    interactive: false,
  });

  renderResult(
    ctx,
    {
      operation: "add",
      project: projectReference(updatedProject),
      resource: projectMutationResource(
        options.resourceType ?? input.resourceType,
        input.resourceConfig.name,
        input,
      ),
    },
    () => config.io.stderr.write(humanSuccessMessage),
  );

  return updatedProject;
}
