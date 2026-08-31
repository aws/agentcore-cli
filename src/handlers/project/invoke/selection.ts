import { InputValidationError, ResourceNotFoundError } from "../../../errors";
import type { Project, ProjectInvokableResource } from "../types";

export function projectResourceNames(
  project: Project,
  resourceType: ProjectInvokableResource,
): string[] {
  return (resourceType === "runtime" ? project.spec.runtimes : project.spec.harnesses).map(
    ({ name }) => name,
  );
}

export function selectProjectResource(
  project: Project,
  resourceType: ProjectInvokableResource,
  name: string | undefined,
): string {
  const names = projectResourceNames(project, resourceType);
  const label = resourceType === "runtime" ? "Runtime" : "Harness";

  if (name !== undefined) {
    if (names.includes(name)) return name;
    throw new ResourceNotFoundError(
      `${label} '${name}' was not found. Available ${label}s: ${names.join(", ") || "none"}.`,
    );
  }
  if (names.length === 1) return names[0]!;
  if (names.length === 0) {
    throw new InputValidationError(`This project has no ${label}s to invoke.`);
  }
  throw new InputValidationError(
    `Project has multiple ${label}s. Specify --name: ${names.join(", ")}.`,
  );
}
