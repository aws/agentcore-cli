import { InputValidationError } from "../../../errors";
import { DEFAULT_TARGET_NAME } from "../../../projectSchemas/aws-targets";
import type { Context } from "../../../router";
import { runWithProgress } from "../../../tui/progress";
import { JsonKey } from "../../keys";
import { renderResult } from "../../utils";
import {
  projectMutationResource,
  projectReference,
  type ProjectMutationResult,
  type ProjectMutationResourceType,
} from "../output";
import type { AddResourceInput, Project } from "../types";
import type { AddProjectResourceConfig } from "./types";

type AddProjectResourceResultOptions = {
  resourceType?: ProjectMutationResourceType;
  notes?: string[];
};

/**
 The L3 deploys `<project><sep><target><sep><name>` and fails at synth past the service cap. This fails at add time for the "default" target the first deploy provisions.
**/
export function requireDeployedNameFits(
  kind: string,
  projectName: string,
  name: string,
  separator: "_" | "-",
  maxLength: number,
): void {
  const deployed = [projectName, DEFAULT_TARGET_NAME, name].join(separator);
  if (deployed.length <= maxLength) return;
  throw new InputValidationError(
    `${kind} deployed name '${deployed}' is ${deployed.length} characters. The maximum is ${maxLength}. The deployed name is <project>${separator}<default target>${separator}<name>. Shorten the ${kind.toLowerCase()} name.`,
  );
}

export async function addProjectResource(
  ctx: Context,
  config: AddProjectResourceConfig,
  project: Project,
  input: AddResourceInput,
  humanSuccessMessage: string,
  options: AddProjectResourceResultOptions = {},
): Promise<Project> {
  // Same driver as create, build, and deploy: a live step list in a TTY, and
  // plain line-per-step output when stderr is not a TTY or --json wants no ANSI
  // on it.
  const updatedProject = await runWithProgress(config.projectManager.addResource(project, input), {
    io: config.io,
    interactive: ctx.require(JsonKey) ? false : undefined,
  });

  renderResult<ProjectMutationResult>(
    ctx,
    {
      operation: "add",
      project: projectReference(updatedProject),
      resource: projectMutationResource(
        options.resourceType ?? input.resourceType,
        input.resourceConfig.name,
        input,
      ),
      ...(options.notes?.length ? { notes: options.notes } : {}),
    },
    () => {
      config.io.stderr.write(`${humanSuccessMessage}\n`);
      for (const note of options.notes ?? []) config.io.stderr.write(`${note}\n`);
    },
  );

  return updatedProject;
}
