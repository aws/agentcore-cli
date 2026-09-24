import { InputValidationError, ResourceNotFoundError } from "../../errors";
import type { Project, ProjectInvokableResource, ProjectObservableResource } from "./types";

export const RESOURCE_LABELS: Record<ProjectInvokableResource, string> = {
  runtime: "Runtime",
  harness: "Harness",
  gateway: "Gateway",
};

export function isProjectInvokableResource(value: string): value is ProjectInvokableResource {
  return value in RESOURCE_LABELS;
}

export function projectResourceNames(
  project: Project,
  resourceType: ProjectInvokableResource,
): string[] {
  const resources = {
    runtime: project.spec.runtimes,
    harness: project.spec.harnesses,
    gateway: project.spec.agentCoreGateways,
  }[resourceType];
  return resources.map(({ name }) => name);
}

export function selectProjectResource(
  project: Project,
  resourceType: ProjectObservableResource,
  name: string | undefined,
  operation: string,
): string {
  const names = projectResourceNames(project, resourceType);
  const label = RESOURCE_LABELS[resourceType];

  if (name !== undefined) {
    if (names.includes(name)) return name;
    throw new ResourceNotFoundError(
      `${label} '${name}' was not found. Available ${label}s: ${names.join(", ") || "none"}.`,
    );
  }
  if (names.length === 1) return names[0]!;
  if (names.length === 0) {
    throw new InputValidationError(`This project has no ${label}s to ${operation}.`);
  }
  throw new InputValidationError(
    `Project has multiple ${label}s. Specify --name: ${names.join(", ")}.`,
  );
}
