import type { AddResourceInput, Project, RemoveResourceInput } from "./types";

export type ProjectMutationResourceType = AddResourceInput["resourceType"] | "gateway-connector";

type ProjectMutationParent =
  | { type: "gateway"; name: string }
  | { type: "policy-engine"; name: string }
  | { type: "payment-manager"; name: string };

type ProjectMutationResource = {
  type: ProjectMutationResourceType;
  name: string;
  parent?: ProjectMutationParent;
};

type ProjectReference = {
  name: string;
  path: string;
};

export type ProjectMutationResult =
  | { operation: "create"; project: ProjectReference }
  | {
      operation: "add";
      project: ProjectReference;
      resource: ProjectMutationResource;
      notes?: string[];
    }
  | {
      operation: "remove";
      project: ProjectReference;
      resource: ProjectMutationResource | { type: "all" };
      removedEnvironmentKeys: string[];
    };

export function projectReference(project: Project): ProjectReference {
  return {
    name: project.name,
    path: project.rootPath,
  };
}

export function projectMutationResource(
  type: ProjectMutationResourceType,
  name: string,
  input: AddResourceInput | RemoveResourceInput,
): ProjectMutationResource {
  const parent = parentFor(input);
  return parent ? { type, name, parent } : { type, name };
}

function parentFor(
  input: AddResourceInput | RemoveResourceInput,
): ProjectMutationParent | undefined {
  switch (input.resourceType) {
    case "gateway-target":
      return { type: "gateway", name: input.gatewayName };
    case "policy":
      return input.engineName ? { type: "policy-engine", name: input.engineName } : undefined;
    case "payment-connector":
      return { type: "payment-manager", name: input.managerName };
    default:
      return undefined;
  }
}
