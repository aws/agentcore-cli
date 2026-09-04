import { ProjectKey, type Context } from "../../../router";
import { runWithProgress } from "../../../tui/progress";
import { projectReference, renderProjectMutationResult } from "../output";
import type { AddResourceInput, Project } from "../types";
import type { AddProjectResourceConfig } from "./types";

type AddProjectResourceResultOptions = {
  resourceType?: string;
};

function parentFor(input: AddResourceInput) {
  switch (input.resourceType) {
    case "gateway-target":
      return { type: "gateway", name: input.gatewayName };
    case "policy":
      return { type: "policy-engine", name: input.engineName };
    case "payment-connector":
      return { type: "payment-manager", name: input.managerName };
    default:
      return undefined;
  }
}

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

  renderProjectMutationResult(
    ctx,
    {
      operation: "add",
      project: projectReference(updatedProject),
      resource: {
        type: options.resourceType ?? input.resourceType,
        name: input.resourceConfig.name,
        parent: parentFor(input),
      },
    },
    () => config.io.stderr.write(humanSuccessMessage),
  );

  return updatedProject;
}
